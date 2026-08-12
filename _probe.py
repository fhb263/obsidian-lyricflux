import json, urllib.request, urllib.parse
# 网易云 weapi 简化：用真实接口需要加密，改用外链测试 song 详情太复杂，直接用歌单详情已知 trackIds
# 这里用一个公开的歌单 3778678 拿 trackIds，再查 song detail
def weapi(url, payload):
    # 简单 weapi：用已实现的加密思路不可行，直接用已知的 test 方式
    pass
print("网易云 weapi 需加密，改用代码内 parseSongDetailSongs 已有字段推断")
