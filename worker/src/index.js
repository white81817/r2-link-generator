export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // POST /upload — 接收 PDF，存入 R2，回傳分享連結
    if (request.method === 'POST' && url.pathname === '/upload') {
      try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) {
          return new Response(JSON.stringify({ error: 'No file' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const id = crypto.randomUUID();
        const key = `${id}.pdf`;
        const buffer = await file.arrayBuffer();

        await env.BUCKET.put(key, buffer, {
          httpMetadata: { contentType: 'application/pdf' },
        });

        const shareUrl = `${url.origin}/file/${id}`;
        return new Response(JSON.stringify({ url: shareUrl }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /api/list-images?prefix=xxx — 列出 shaner-assets 該路徑下所有圖片
    if (request.method === 'GET' && url.pathname === '/api/list-images') {
      try {
        const prefix = url.searchParams.get('prefix') || '';
        const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

        const keys = [];
        let cursor;
        do {
          const listed = await env.ASSETS_BUCKET.list({ prefix, limit: 1000, cursor });
          for (const obj of listed.objects) {
            if (IMAGE_EXT.test(obj.key)) keys.push(obj.key);
          }
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);

        // 依檔名中的數字自然排序（1.jpg < 2.jpg < 10.jpg）
        keys.sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true, sensitivity: 'base' }));

        return new Response(JSON.stringify({ prefix, count: keys.length, keys }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /file/:id — 從 R2 讀取並回傳 PDF
    if (request.method === 'GET' && url.pathname.startsWith('/file/')) {
      const id = url.pathname.slice('/file/'.length);
      if (!id) return new Response('Not found', { status: 404, headers: corsHeaders });

      const object = await env.BUCKET.get(`${id}.pdf`);
      if (!object) {
        return new Response('File not found or expired', { status: 404, headers: corsHeaders });
      }

      return new Response(object.body, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'inline',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
