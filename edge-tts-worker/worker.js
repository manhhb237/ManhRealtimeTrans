/**
 * Edge TTS Cloudflare Worker Proxy
 * 
 * Proxies requests to Microsoft's Edge TTS WebSocket service.
 * Deploy to Cloudflare Workers (free tier: 100k requests/day).
 * 
 * Endpoint: GET /tts?text=...&voice=...&rate=...
 * Returns: audio/mpeg stream
 */

const WS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

function uuid() {
  return crypto.randomUUID().replace(/-/g, '');
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSSML(text, voice, rate) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>` +
    escapeXml(text) +
    `</prosody></voice></speak>`;
}

async function synthesize(text, voice, rate) {
  const connId = uuid();
  const requestId = uuid();
  const wsUrl = `${WS_URL}?TrustedClientToken=${TOKEN}&ConnectionId=${connId}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
      }
    });

    const audioChunks = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error('Synthesis timeout'));
      }
    }, 30000);

    ws.addEventListener('open', () => {
      // Send speech config
      const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataOptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'false'
                },
                outputFormat: OUTPUT_FORMAT
              }
            }
          }
        });
      ws.send(configMsg);

      // Send SSML
      const ssml = buildSSML(text, voice, rate);
      const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
      ws.send(ssmlMsg);
    });

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            ws.close();
            resolve(audioChunks);
          }
        }
      } else if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const headerLen = view.getUint16(0);
        if (event.data.byteLength > headerLen + 2) {
          audioChunks.push(event.data.slice(headerLen + 2));
        }
      }
    });

    ws.addEventListener('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('WebSocket error'));
      }
    });

    ws.addEventListener('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        if (audioChunks.length > 0) {
          resolve(audioChunks);
        } else {
          reject(new Error('WebSocket closed without audio'));
        }
      }
    });
  });
}

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname !== '/tts') {
      return new Response('Edge TTS Proxy. Use GET /tts?text=...&voice=...&rate=...', {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const text = url.searchParams.get('text');
    const voice = url.searchParams.get('voice') || 'ja-JP-NanamiNeural';
    const rate = url.searchParams.get('rate') || '+0%';

    if (!text) {
      return new Response(JSON.stringify({ error: 'text parameter required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      const audioChunks = await synthesize(text, voice, rate);

      // Merge chunks into a single ArrayBuffer
      let totalLen = 0;
      for (const chunk of audioChunks) totalLen += chunk.byteLength;
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of audioChunks) {
        merged.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }

      return new Response(merged.buffer, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
