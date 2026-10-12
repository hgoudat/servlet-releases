"""Extract reviewed build archives without path traversal or symlink writes."""
import os
from pathlib import Path, PurePosixPath
import posixpath
import stat
import sys
import zipfile

def extract(archive, target, app=False):
    root=Path(target).resolve()
    root.mkdir(parents=True,exist_ok=True)
    links={}
    with zipfile.ZipFile(archive) as z:
        members=z.infolist()
        if len(members)>30000 or sum(i.file_size for i in members)>2*1024**3:
            raise ValueError('Archive exceeds its extraction limit')
        seen=set()
        for info in members:
            name=info.filename
            parts=PurePosixPath(name).parts
            if not parts or name.startswith('/') or '..' in parts or '\\' in name or ':' in name or '\x00' in name or name in seen:
                raise ValueError('Unsafe archive entry')
            seen.add(name)
            if app and parts[0]=='__MACOSX': continue
            if app and parts[0]!='Servlet.app': raise ValueError('Unexpected application archive')
            if not app and len(parts)!=1: raise ValueError('Build artifact must contain flat files')
            mode=(info.external_attr>>16)&0xffff
            if stat.S_ISLNK(mode):
                if not app or info.file_size>4096: raise ValueError('Unexpected symlink')
                link=z.read(info).decode('utf-8')
                destination=posixpath.normpath(posixpath.join(posixpath.dirname(name),link))
                if link.startswith('/') or '\\' in link or ':' in link or not destination.startswith('Servlet.app/'):
                    raise ValueError('Symlink escapes application')
                links[name]=(link,destination)
            elif not (info.is_dir() or stat.S_ISREG(mode) or stat.S_IFMT(mode)==0):
                raise ValueError('Unexpected file type')
        for info in members:
            if info.filename.startswith('__MACOSX/') or info.filename in links: continue
            if any(info.filename.startswith(name+'/') for name in links): raise ValueError('Archive writes beneath a symlink')
            dest=root/info.filename
            if info.is_dir(): dest.mkdir(parents=True,exist_ok=True);continue
            dest.parent.mkdir(parents=True,exist_ok=True)
            with z.open(info) as source,open(dest,'xb') as output:
                while True:
                    chunk=source.read(1024*1024)
                    if not chunk: break
                    output.write(chunk)
            os.chmod(dest,((info.external_attr>>16)&0o777) or 0o644)
        # Resolve chains before creating any symlink.
        for name,(link,destination) in links.items():
            current=destination
            for _ in range(100):
                prefix=next((p for p in links if current==p or current.startswith(p+'/')),None)
                if prefix is None: break
                current=posixpath.normpath(links[prefix][1]+current[len(prefix):])
                if not current.startswith('Servlet.app/'): raise ValueError('Symlink chain escapes application')
            else: raise ValueError('Cyclic archive symlink')
            dest=root/name;dest.parent.mkdir(parents=True,exist_ok=True);os.symlink(link,dest)
    return root
if __name__=='__main__': extract(sys.argv[1],sys.argv[2],len(sys.argv)>3 and sys.argv[3]=='app')
