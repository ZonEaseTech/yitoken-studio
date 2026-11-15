# SPDX-License-Identifier: AGPL-3.0-or-later
import argparse
import hashlib
import json
import re


def patch_generator(source, script_url):
    if not re.fullmatch(r'/site-download-entry\.[0-9a-f]{12,64}\.js', script_url):
        raise ValueError('Only a same-origin fingerprinted module path is permitted')
    marker = '# YITOKEN_SITE_DOWNLOAD_ENTRY_BEGIN'
    original = '    for name, content in pages.items():\n        (OUT / name).write_text(content, encoding="utf-8")'
    patched_output = '    for name, content in pages.items():\n        content = add_site_download_entries(content, name)\n        (OUT / name).write_text(content, encoding="utf-8")'
    pages_seam = '    pages = {}\n'
    app_shell = "    pages['app-shell.html'] = base\n"
    if source.count(pages_seam) != 1 or source.count('def main():') != 1:
        raise ValueError('Current generator does not match the reviewed pages seam')
    if marker in source:
        if 'SITE_DOWNLOAD_ENTRY_URL = ' + json.dumps(script_url) not in source:
            raise ValueError('An existing different entry patch must be reviewed first')
        if source.count(patched_output) != 1:
            raise ValueError('Current generator does not match the reviewed publication seam')
        end_marker = '# YITOKEN_SITE_DOWNLOAD_ENTRY_END'
        if source.count(marker) != 1 or source.count(end_marker) != 1:
            raise ValueError('Current generator does not match the reviewed helper boundaries')
        before, _, rest = source.partition(marker)
        helper_source, _, after = rest.partition(end_marker)
        for old_literal in [
            "'<nav aria-label=\"软件下载\"><a href=\"/downloads/\">软件下载</a></nav>'",
            "'<footer><a href=\"/downloads/\">软件下载</a></footer>'",
            "'<a href=\"/downloads/\">软件下载</a></nav>'",
            "'<span> · <a href=\"/downloads/\">软件下载</a></span></footer>'",
        ]:
            new_literal = old_literal.replace('软件下载', '桌面创作客户端')
            known_literals = [old_literal, new_literal]
            if old_literal.endswith("</nav>'"):
                known_literals += [literal.replace('href="/downloads/"', 'href="/downloads/" target="_blank" rel="noopener noreferrer"') for literal in known_literals]
                new_literal = known_literals[-1]
            if sum(helper_source.count(literal) for literal in known_literals) != 1:
                raise ValueError('Current generator does not match the reviewed helper labels')
            for literal in known_literals:
                helper_source = helper_source.replace(literal, new_literal, 1)
        old_note = '<p>Windows / macOS / Linux 预发布桌面客户端；API Key 由用户自行在 YITOKEN 官网获取。</p>'
        new_note = old_note.replace(' 预发布', ' ')
        if helper_source.count(old_note) + helper_source.count(new_note) != 1:
            raise ValueError('Current generator does not match the reviewed homepage note')
        helper_source = helper_source.replace(old_note, new_note, 1)
        source = before + marker + helper_source + end_marker + after
        if app_shell in source:
            if source.count(app_shell) != 1 or pages_seam + app_shell not in source:
                raise ValueError('Current generator does not match the reviewed app-shell seam')
            return source
        return source.replace(pages_seam, pages_seam + app_shell, 1)
    if source.count(original) != 1:
        raise ValueError('Current generator does not match the reviewed publication seam')
    helper = '''# YITOKEN_SITE_DOWNLOAD_ENTRY_BEGIN
SITE_DOWNLOAD_ENTRY_URL = __MODULE_URL__
def add_site_download_entries(content, name):
    if name == "404.html" or "data-yitoken-site-download-entry" in content:
        return content
    if '<div id="root"' in content:
        tag = '<script type="module" src="' + SITE_DOWNLOAD_ENTRY_URL + '" data-yitoken-site-download-entry="1"></script>'
        content = content.replace("</head>", tag + "\\n</head>", 1)
    if name == "home.html":
        nav = '<nav aria-label="桌面创作客户端"><a href="/downloads/" target="_blank" rel="noopener noreferrer">桌面创作客户端</a></nav>'
        card = '<section><h2>YITOKEN Studio · AI 视频创作与本地整片合成</h2><p>Windows / macOS / Linux 桌面客户端；API Key 由用户自行在 YITOKEN 官网获取。</p><a href="/downloads/">下载 YITOKEN Studio</a></section>'
        footer = '<footer><a href="/downloads/">桌面创作客户端</a></footer>'
        content = re.sub(r'(<div id="seo-content">)(.*?)(</div>\\s*<script>)', lambda m: m[1] + nav + m[2] + card + footer + m[3], content, count=1, flags=re.S)
    elif name == "faq.html":
        content = content.replace("</nav>", '<a href="/downloads/" target="_blank" rel="noopener noreferrer">桌面创作客户端</a></nav>', 1)
        content = content.replace("</footer>", '<span> · <a href="/downloads/">桌面创作客户端</a></span></footer>', 1)
    return content
# YITOKEN_SITE_DOWNLOAD_ENTRY_END

'''.replace('__MODULE_URL__', json.dumps(script_url))
    result = source.replace('def main():', helper + 'def main():', 1)
    result = result.replace(pages_seam, pages_seam + app_shell, 1)
    return result.replace(original, patched_output, 1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--script-url', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    with open(args.source, 'rb') as handle:
        raw = handle.read()
    if hashlib.sha256(raw).hexdigest() != args.expected_sha256:
        raise SystemExit('Baseline mismatch: refuse to patch a concurrently modified generator')
    result = patch_generator(raw.decode(), args.script_url)
    compile(result, args.output, 'exec')
    with open(args.output, 'x', encoding='utf-8') as handle:
        handle.write(result)
