import ast
import hashlib
import unittest
from patch_shells import patch_generator

BASE = '''# new-api / QuantumNous references must remain unchanged
import pathlib, re
OUT = pathlib.Path('.')
def main():
    pages = {'home.html': '<html><head></head><body><div id="root"></div><div id="seo-content"><h1>Original content</h1></div><script>original()</script></body></html>'}
    for name, content in pages.items():
        (OUT / name).write_text(content, encoding="utf-8")
'''
URL = '/site-download-entry.123456789abc.js'

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
        self.assertEqual(rendered, namespace['add_site_download_entries'](rendered, 'home.html'))
        self.assertEqual(result, patch_generator(result, URL))

    def test_faq_gets_plain_links_and_404_is_unchanged(self):
        namespace = {}; exec(patch_generator(BASE, URL), namespace)
        old = '<html><nav><a href="/about">About</a></nav><main>FAQ original</main><footer>Original copyright</footer></html>'
        rendered = namespace['add_site_download_entries'](old, 'faq.html')
        self.assertIn('FAQ original', rendered); self.assertIn('Original copyright', rendered)
        self.assertEqual(rendered.count('href="/downloads/"'), 2)
        self.assertNotIn('<script', rendered)
        self.assertEqual(namespace['add_site_download_entries'](old, '404.html'), old)

    def test_unknown_generator_shape_and_arbitrary_script_targets_are_rejected(self):
        with self.assertRaises(ValueError): patch_generator('unrecognized', URL)
        for url in ['https://external.invalid/code.js', '/../../private.js', '/script.js?token=private', 'javascript:bad()']:
            with self.assertRaises(ValueError): patch_generator(BASE, url)
