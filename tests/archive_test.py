import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile
spec=importlib.util.spec_from_file_location('safe_unzip','scripts/safe-unzip.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class ArchiveTests(unittest.TestCase):
 def test_build_archive_rejects_traversal_and_symlinks(self):
  for name in ['../secret','/tmp/secret','dir/secret','C:\\secret']:
   with tempfile.TemporaryDirectory() as d:
    archive=Path(d)/'input.zip'
    with zipfile.ZipFile(archive,'w') as z:z.writestr(name,b'fixture')
    with self.assertRaises(ValueError):mod.extract(archive,Path(d)/'out')
 def test_app_preserves_safe_framework_links_but_rejects_escape(self):
  for target,allowed in [('A',True),('../../../../../../outside',False)]:
   with tempfile.TemporaryDirectory() as d:
    archive=Path(d)/'input.zip'
    with zipfile.ZipFile(archive,'w') as z:
     z.writestr('Servlet.app/Contents/Frameworks/Example.framework/Versions/A/file',b'fixture')
     info=zipfile.ZipInfo('Servlet.app/Contents/Frameworks/Example.framework/Versions/Current');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(info,target)
    if allowed:
     mod.extract(archive,Path(d)/'out',True);self.assertEqual((Path(d)/'out/Servlet.app/Contents/Frameworks/Example.framework/Versions/Current/file').read_bytes(),b'fixture')
    else:
     with self.assertRaises(ValueError):mod.extract(archive,Path(d)/'out',True)
