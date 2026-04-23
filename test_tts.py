import asyncio
import websockets
import time
import hashlib

def get_token():
    ticks = int(time.time() * 10000000) + 116444736000000000
    ticks = ticks - (ticks % 3000000000)
    msg = str(ticks) + "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
    return hashlib.sha256(msg.encode('ascii')).hexdigest().upper()

async def test_edge_tts():
    token = get_token()
    url = f"wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=1234567890&Sec-MS-GEC={token}&Sec-MS-GEC-Version=1-130.0.2849.68"
    
    headers = {
        "Origin": "https://manhrealtimetrans.web.app"
    }
    
    try:
        # Some versions of websockets use extra_headers, some use headers.
        try:
            conn = websockets.connect(url, extra_headers=headers)
        except TypeError:
            conn = websockets.connect(url, headers=headers)
            
        async with conn as ws:
            print("Connected!")
            
            config_msg = 'Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":false,"wordBoundaryEnabled":false},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
            await ws.send(config_msg)
            
            ssml_msg = 'X-RequestId:abcdef\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="en-US-AriaNeural">Hello world</voice></speak>'
            await ws.send(ssml_msg)
            
            while True:
                msg = await ws.recv()
                if isinstance(msg, bytes):
                    print(f"Received {len(msg)} bytes audio")
                else:
                    print("Received string:", msg[:50])
                    if "Path:turn.end" in msg:
                        break
            print("Done")
    except Exception as e:
        print("Failed:", e)

asyncio.run(test_edge_tts())
