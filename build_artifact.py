#!/usr/bin/env python3
"""把 index.html + app.js 打包成單檔（供 Artifact 發佈用）。
Artifact 會自行包上 doctype/head/body，所以這裡只輸出 title + style + body 內容 + inline script。"""
import re, pathlib

d = pathlib.Path(__file__).parent
html = (d / "index.html").read_text(encoding="utf-8")
js = (d / "app.js").read_text(encoding="utf-8")

style = re.search(r"<style>(.*?)</style>", html, re.S).group(1)
body = re.search(r"<body>(.*?)<script src=\"app\.js\"></script>", html, re.S).group(1)

# 拿掉 Service Worker 註冊（Artifact 環境沒有 sw.js，且不需要離線快取）
js = re.sub(
    r"/\* Service Worker.*?\n}\n",
    "/* Service Worker 註冊已在單檔版移除 */\n",
    js, flags=re.S, count=1
)

banner = """
<div class="note" style="margin:0 0 14px">
  這是可直接在 Pixel 9a 上實測的單檔版本。完整 PWA 原始碼（含 manifest / service worker /
  可安裝到桌面）請見對話中的檔案。
</div>
"""

out = f"""<title>常駐音訊保持喚醒</title>
<style>
{style}
</style>
{body.replace('<p class="sub">Live Caption Keep-Alive · Web Audio 永不休眠管線</p>',
              '<p class="sub">Live Caption Keep-Alive · Web Audio 永不休眠管線</p>' + banner, 1)}
<script>
{js}
</script>
"""
(d / "artifact.html").write_text(out, encoding="utf-8")
print("artifact.html", len(out), "bytes")
