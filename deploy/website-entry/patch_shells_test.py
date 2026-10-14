import ast
import pathlib
import tempfile
import unittest
from patch_shells import patch_generator

RAW_BASE = '<!doctype html>\n<html><head><!-- new-api / QuantumNous --><title>Console</title><script type="module" src="/assets/original.js"></script></head><body><div id="root"></div></body></html>\n'
BASE = '''# new-api / QuantumNous references must remain unchanged
import pathlib, re
OUT = pathlib.Path('.')
def main():
    base = __RAW_BASE__
    pages = {}
    pages['home.html'] = '<html><head></head><body><div id="root"></div><div id="seo-content"><h1>Original content</h1></div><script>original()</script></body></html>'
    for name, content in pages.items():
        (OUT / name).write_text(content, encoding="utf-8")
'''.replace('__RAW_BASE__', repr(RAW_BASE))
URL = '/site-download-entry.123456789abc.js'
APP_SHELL_ASSIGNMENT = "    pages['app-shell.html'] = base\n"

def render_app_shell(source):
    namespace = {}; exec(source, namespace)
    with tempfile.TemporaryDirectory() as directory:
        namespace['OUT'] = pathlib.Path(directory)
        namespace['main']()
        return (namespace['OUT'] / 'app-shell.html').read_bytes()

class PatchShellTests(unittest.TestCase):
    def test_generated_home_keeps_content_and_adds_native_nojs_entries_and_module(self):
        result = patch_generator(BASE, URL)
        ast.parse(result)
        namespace = {}
        exec(result, namespace)
        old = '<html><head><!-- QuantumNous --></head><body><div id="root"></div><div id="seo-content"><h1>Original content</h1><div>Nested original</div></div><script>original()</script></body></html>'
        rendered = namespace['add_site_download_entries'](old, 'home.html')
        self.assertIn('<h1>Original content</h1><div>Nested original</div>', rendered)
        self.assertIn('<!-- QuantumNous -->', rendered)
        self.assertIn('src="' + URL + '"', rendered)
        self.assertEqual(rendered.count('href="/downloads/"'), 3)
        self.assertIn('<nav aria-label="桌面创作客户端"><a href="/downloads/">桌面创作客户端</a></nav>', rendered)
        self.assertIn('<footer><a href="/downloads/">桌面创作客户端</a></footer>', rendered)
        self.assertIn('下载 YITOKEN Studio', rendered)
        self.assertNotIn('预发布', rendered)
        self.assertEqual(rendered, namespace['add_site_download_entries'](rendered, 'home.html'))
        self.assertEqual(result, patch_generator(result, URL))

    def test_faq_gets_plain_links_and_404_is_unchanged(self):
        namespace = {}; exec(patch_generator(BASE, URL), namespace)
        old = '<html><nav><a href="/about">About</a></nav><main>FAQ original</main><footer>Original copyright</footer></html>'
        rendered = namespace['add_site_download_entries'](old, 'faq.html')
        self.assertIn('FAQ original', rendered); self.assertIn('Original copyright', rendered)
        self.assertEqual(rendered.count('href="/downloads/"'), 2)
        self.assertEqual(rendered.count('>桌面创作客户端</a>'), 2)
        self.assertNotIn('<script', rendered)
        self.assertEqual(namespace['add_site_download_entries'](old, '404.html'), old)

    def test_first_patch_generates_raw_app_shell_with_only_the_module_added(self):
        result = patch_generator(BASE, URL)
        self.assertIn(APP_SHELL_ASSIGNMENT, result)
        tag = '<script type="module" src="' + URL + '" data-yitoken-site-download-entry="1"></script>\n'
        rendered = render_app_shell(result)
        self.assertEqual(rendered, RAW_BASE.replace('</head>', tag + '</head>', 1).encode())
        self.assertEqual(rendered.replace(tag.encode(), b'', 1), RAW_BASE.encode())
        self.assertNotIn(b'seo-content', rendered)
        self.assertNotIn(b'href="/downloads/"', rendered)
        self.assertEqual(result, patch_generator(result, URL))

    def test_same_url_legacy_patch_is_upgraded_without_replacing_existing_code(self):
        patched = patch_generator(BASE, URL)
        legacy = patched.replace(APP_SHELL_ASSIGNMENT, '')
        upgraded = patch_generator(legacy, URL)
        self.assertIn(APP_SHELL_ASSIGNMENT, upgraded)
        self.assertEqual(upgraded.replace(APP_SHELL_ASSIGNMENT, ''), legacy)
        self.assertEqual(render_app_shell(upgraded), render_app_shell(patched))
        self.assertEqual(upgraded, patch_generator(upgraded, URL))

    def test_same_url_old_labels_upgrade_only_known_helper_literals(self):
        current = patch_generator(BASE, URL)
        legacy = current.replace('桌面创作客户端', '软件下载').replace('Windows / macOS / Linux 桌面客户端；', 'Windows / macOS / Linux 预发布桌面客户端；')
        legacy = legacy.replace('# YITOKEN_SITE_DOWNLOAD_ENTRY_END', '# User helper note: 软件下载\n# YITOKEN_SITE_DOWNLOAD_ENTRY_END')
        user_code = '\nUSER_COPY = "软件下载"\ndef original_database_reader():\n    return USER_COPY\n'
        legacy += user_code
        expected = current.replace('# YITOKEN_SITE_DOWNLOAD_ENTRY_END', '# User helper note: 软件下载\n# YITOKEN_SITE_DOWNLOAD_ENTRY_END') + user_code
        for source in [legacy, legacy.replace(APP_SHELL_ASSIGNMENT, '')]:
            upgraded = patch_generator(source, URL)
            self.assertEqual(upgraded, expected, 'Only reviewed helper literals and the app-shell assignment may change')
            namespace = {}; exec(upgraded, namespace)
            html = '<html><head></head><body><div id="root"></div><div id="seo-content">Original</div><script>original()</script></body></html>'
            self.assertIn('>桌面创作客户端</a>', namespace['add_site_download_entries'](html, 'home.html'))
            self.assertIn('# User helper note: 软件下载', upgraded)
            self.assertEqual(namespace['original_database_reader'](), '软件下载')
            self.assertEqual(upgraded, patch_generator(upgraded, URL))
            self.assertEqual(render_app_shell(upgraded), render_app_shell(current))
            with self.assertRaises(ValueError): patch_generator(source, '/site-download-entry.abcdef123456.js')

    def test_unknown_pages_seam_is_rejected_even_for_same_url_legacy_patch(self):
        legacy = patch_generator(BASE, URL).replace(APP_SHELL_ASSIGNMENT, '')
        for source in [BASE, legacy]:
            for changed in [source.replace('    pages = {}\n', '    pages = dict()\n'),
                            source.replace('    pages = {}\n', '    pages = {}\n    pages = {}\n')]:
                with self.assertRaises(ValueError): patch_generator(changed, URL)

    def test_different_url_patch_is_not_automatically_replaced(self):
        patched = patch_generator(BASE, URL)
        for source in [patched, patched.replace(APP_SHELL_ASSIGNMENT, '')]:
            with self.assertRaises(ValueError): patch_generator(source, '/site-download-entry.abcdef123456.js')

    def test_404_and_unknown_non_spa_material_are_not_injected(self):
        namespace = {}; exec(patch_generator(BASE, URL), namespace)
        for content, name in [(RAW_BASE, '404.html'), ('<html><head></head><body>Unknown asset</body></html>', 'unknown.html')]:
            self.assertEqual(namespace['add_site_download_entries'](content, name), content)

    def test_unknown_generator_shape_and_arbitrary_script_targets_are_rejected(self):
        with self.assertRaises(ValueError): patch_generator('unrecognized', URL)
        for url in ['https://external.invalid/code.js', '/../../private.js', '/script.js?token=private', 'javascript:bad()']:
            with self.assertRaises(ValueError): patch_generator(BASE, url)
