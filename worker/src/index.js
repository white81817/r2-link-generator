// encodeURI 不會編碼 ? & # 等字元，檔名帶到就會被當成 query；逐段編碼才安全
function encodePath(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

// ===== 無相依的 ZIP 打包（STORE，不壓縮）=====
// 圖片本來就是壓過的格式，deflate 幾乎沒有收益，換來的是零 npm 相依、
// 這支 worker 仍可用 Cloudflare 後台編輯器直接貼上。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (arr) => { chunks.push(arr); offset += arr.length; };
  const u16 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
  const u32 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
  const cat = (...parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const localAt = offset;
    // 一律標記 UTF-8 檔名（bit 11），時間戳固定為 1980/01/01 讓輸出可重現
    push(cat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021),
             u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes));
    push(data);
    central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021),
                     u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length),
                     u16(0), u16(0), u16(0), u16(0), u32(0), u32(localAt), nameBytes));
  }

  const centralAt = offset;
  for (const c of central) push(c);
  const centralSize = offset - centralAt;
  push(cat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
           u32(centralSize), u32(centralAt), u16(0)));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Expose-Headers': 'X-Zip-Count, X-Zip-Missing, X-Zip-Report, X-Img-Quality, X-Img-Bytes, X-Img-Fallback',
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

    // GET /api/img/<key>?w=&h=&max=&fit= — 給上架平台用的「固定輸出」圖片網址
    // 前台的 img.* 轉檔 worker 是看 Accept 決定格式（會回 AVIF/WebP），
    // 但蝦皮只收 JPG/JPEG/PNG，平台爬蟲送什麼 header 我們控制不了，
    // 所以這裡一律輸出 JPEG、尺寸寫死，不做內容協商。
    // max（KB）是目標檔案大小：由高畫質往下試，落進範圍就停。
    if (request.method === 'GET' && url.pathname.startsWith('/api/img/')) {
      const IMAGE_ORIGIN = (env.IMAGE_ORIGIN || 'https://photos.shaner.com.tw').replace(/\/+$/, '');
      const key = decodeURIComponent(url.pathname.slice('/api/img/'.length));
      if (!key) return new Response('Missing key', { status: 400, headers: corsHeaders });

      const w = Number(url.searchParams.get('w')) || 0;
      const h = Number(url.searchParams.get('h')) || 0;
      const maxKB = Number(url.searchParams.get('max')) || 0;
      // 只給寬度時用 scale-down 保持比例，長圖裁成正方形會毀版面
      const fit = url.searchParams.get('fit') || (h ? 'cover' : 'scale-down');
      const src = `${IMAGE_ORIGIN}/${encodePath(key)}`;

      try {
        let body = null;
        let usedQuality = 0;
        for (const quality of [90, 78, 65, 50]) {
          const res = await fetch(src, {
            cf: { image: { ...(w ? { width: w } : {}), ...(h ? { height: h } : {}), fit, format: 'jpeg', quality } },
          });
          if (!res.ok) break;
          const buf = new Uint8Array(await res.arrayBuffer());
          body = buf; usedQuality = quality;
          if (!maxKB || buf.length <= maxKB * 1024) break;
        }
        // 轉檔失敗（Image Resizing 沒開、原檔不存在）就退回原始物件，不要回空圖
        if (!body) {
          const obj = await env.ASSETS_BUCKET.get(key);
          if (!obj) return new Response(`Not found: ${key}`, { status: 404, headers: corsHeaders });
          return new Response(obj.body, {
            headers: {
              ...corsHeaders,
              'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
              'Cache-Control': 'public, max-age=86400',
              'X-Img-Fallback': 'original',
            },
          });
        }
        return new Response(body, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'image/jpeg',
            'Content-Length': String(body.length),
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Content-Disposition': 'inline',
            'X-Img-Quality': String(usedQuality),
            'X-Img-Bytes': String(body.length),
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /api/health — 用來確認這支 worker 有沒有部署到最新版
    // 改動 worker 時一併更新 version，開瀏覽器看數字就知道有沒有生效。
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return new Response(JSON.stringify({
        ok: true,
        worker: 'label-sticker-worker',
        version: '2026-08-26-img-v1',
        routes: ['/upload', '/file/:id', '/api/list-images', '/api/img/:key', '/api/zip', '/api/health'],
        imageOrigin: env.IMAGE_ORIGIN || '(未設定，預設 https://photos.shaner.com.tw)',
        hasAssetsBucket: !!env.ASSETS_BUCKET,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // POST /api/zip — 依 { files: [{ key, name, w, h }] } 取檔、（可選）裁切後打包成 ZIP
    // momo購物網的圖片不是填網址，而是整包 ZIP 上傳、靠檔名對應商品編碼，所以改名的工作在這裡做。
    // 帶 w/h 時走 Cloudflare 的 cf.image 裁切：來源必須是「原檔」網域（photos.*），
    // 打 img.* 會再進到轉檔 worker 造成迴圈，這點與該 worker 的做法一致。
    if (request.method === 'POST' && url.pathname === '/api/zip') {
      try {
        const body = await request.json();
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) {
          return new Response(JSON.stringify({ error: 'files 為空' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        if (files.length > 200) {
          return new Response(JSON.stringify({ error: `一次最多 200 個檔案，收到 ${files.length}` }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const IMAGE_ORIGIN = (env.IMAGE_ORIGIN || 'https://photos.shaner.com.tw').replace(/\/+$/, '');
        const entries = [];
        const missing = [];
        const report = [];
        for (const f of files) {
          const key = String(f.key || '');
          // ZIP 內不可有資料夾（momo 規定），檔名一律取最後一段
          const name = String(f.name || '').split('/').pop();
          if (!key || !name) continue;

          let data = null;
          let resized = false;
          const w = Number(f.w) || 0;
          const h = Number(f.h) || 0;
          if (w && h) {
            try {
              const res = await fetch(`${IMAGE_ORIGIN}/${encodePath(key)}`, {
                cf: { image: { width: w, height: h, fit: 'cover', format: 'jpeg', quality: 90 } },
              });
              if (res.ok) {
                data = new Uint8Array(await res.arrayBuffer());
                resized = true;
              }
            } catch { /* 裁切失敗就退回原圖，不讓整包失敗 */ }
          }
          if (!data) {
            const obj = await env.ASSETS_BUCKET.get(key);
            if (!obj) { missing.push(key); continue; }
            data = new Uint8Array(await obj.arrayBuffer());
          }
          entries.push({ name, data });
          report.push({ name, size: data.length, resized });
        }
        if (!entries.length) {
          return new Response(JSON.stringify({ error: '所有檔案都讀不到', missing }), {
            status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const zip = buildZip(entries);
        return new Response(zip, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/zip',
            'Content-Length': String(zip.length),
            // 讀不到的檔案不能靜默吞掉，用 header 回報讓前端提醒使用者
            'X-Zip-Count': String(entries.length),
            'X-Zip-Missing': String(missing.length),
            // 每個檔的實際大小與是否裁切過，讓前端能檢查 momo 的檔案大小限制
            'X-Zip-Report': btoa(JSON.stringify(report)),
          },
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
