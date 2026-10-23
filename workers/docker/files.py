"""Bounded workspace operations over stdin; invoked only by the core Docker lease."""
import os, sys, json, stat, base64, errno
LIMIT = 8 * 1024 * 1024

def inside(root, path):
    if os.path.commonpath([root, path]) != root:
        raise PermissionError("path is outside the trusted workspace")

def checked(root, path, options=None):
    options = options or {}
    if not isinstance(path, str) or not path or "\0" in path:
        raise ValueError("path must be a non-empty string")
    candidate = os.path.abspath(os.path.join(root, path))
    inside(root, candidate)
    resolved = os.path.realpath(candidate)
    inside(root, resolved)
    if options.get("forbidSymlinks"):
        current = root
        for part in os.path.relpath(candidate, root).split(os.sep):
            current = os.path.join(current, part)
            if os.path.islink(current): raise PermissionError("path is a symlink")
    if not options.get("allowMissingLeaf") and not os.path.exists(resolved):
        raise FileNotFoundError(errno.ENOENT, "path does not exist")
    if not options.get("allowDirectory") and os.path.isdir(resolved):
        raise IsADirectoryError("path points to a directory")
    return resolved

def parent_fd(root, path):
    inside(root, path)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = os.path.relpath(path, root).split(os.sep)
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = next_fd
        return fd, parts[-1]
    except BaseException:
        os.close(fd); raise

def metadata(info):
    kind = "file" if stat.S_ISREG(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "special"
    return {"kind":kind, "size":info.st_size,"mode":info.st_mode,"uid":info.st_uid,"gid":info.st_gid,"ino":info.st_ino,"nlink":info.st_nlink,
            "mtimeMs":info.st_mtime*1000,"atimeMs":info.st_atime*1000,"ctimeMs":info.st_ctime*1000,"birthtimeMs":getattr(info,"st_birthtime",info.st_ctime)*1000}

def main(request):
    root = request["root"]
    if os.path.realpath(root) != root: raise PermissionError("workspace root changed")
    op, path = request["op"], request.get("path")
    options = request.get("options", {})
    if op == "resolve": return checked(root, path, options)
    if op == "output-metadata":
        resolved = checked(root, path, {"allowMissingLeaf": True, "forbidSymlinks": True})
        try:
            fd, leaf = parent_fd(root, resolved)
        except FileNotFoundError:
            return None
        try:
            try: info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError: return None
            if not stat.S_ISREG(info.st_mode): raise ValueError("output must be a regular file")
            return metadata(info)
        finally: os.close(fd)
    mutation = op in ("write", "mkdir", "rm", "rename")
    resolved = checked(root, path, {"allowDirectory":op in ("stat", "lstat", "readdir", "mkdir"), "allowMissingLeaf":op in ("write", "mkdir") or (op=="rm" and options.get("force")), "forbidSymlinks":mutation or op == "preview"})
    if mutation and resolved == root: raise PermissionError("cannot replace workspace root")
    if op == "lstat": resolved = os.path.join(os.path.realpath(os.path.dirname(os.path.abspath(os.path.join(root,path)))), os.path.basename(path))
    fd, leaf = parent_fd(root, resolved)
    try:
        if op in ("stat", "lstat"): return metadata(os.stat(leaf, dir_fd=fd, follow_symlinks=False))
        if op == "preview":
            file = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            with os.fdopen(file,"rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode): raise ValueError("preview requires a regular file")
                data = source.read(16384)
                after = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
                if (info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns): raise ValueError("file changed")
                return {"bytes":base64.b64encode(data).decode("ascii"),"size":info.st_size}
        if op == "read":
            file = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            with os.fdopen(file,"rb") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise ValueError("workspace reads require regular files")
                data = source.read(LIMIT + 1)
                if len(data)>LIMIT: raise ValueError("workspace file exceeds 8 MiB read limit")
                return base64.b64encode(data).decode("ascii")
        if op == "write":
            data = request["content"].encode("utf8")
            if len(data)>LIMIT: raise ValueError("workspace write exceeds 8 MiB limit")
            flag = options.get("flag","w")
            if flag not in ("w","wx","a","ax"): raise ValueError("unsupported file write flag")
            flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
            flags |= os.O_EXCL if "x" in flag else 0
            flags |= os.O_APPEND if flag.startswith("a") else 0
            file = os.open(leaf, flags, 0o600, dir_fd=fd)
            with os.fdopen(file,"wb") as target:
                if not stat.S_ISREG(os.fstat(target.fileno()).st_mode): raise ValueError("workspace writes require regular files")
                if flag.startswith("w"): os.ftruncate(target.fileno(), 0)
                target.write(data)
            return None
        if op == "mkdir": os.mkdir(leaf, dir_fd=fd); return None
        if op == "rm":
            try: os.unlink(leaf, dir_fd=fd)
            except FileNotFoundError:
                if not options.get("force"): raise
            return None
        if op == "rename":
            destination = checked(root, request["to"], {"allowMissingLeaf":True,"forbidSymlinks":True})
            targetfd, target = parent_fd(root, destination)
            try: os.rename(leaf, target, src_dir_fd=fd, dst_dir_fd=targetfd)
            finally: os.close(targetfd)
            return None
        if op == "readdir":
            directory = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                results=[]
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if len(results)>=20000: raise ValueError("directory enumeration limit reached")
                        results.append({"name":entry.name,**metadata(entry.stat(follow_symlinks=False))})
                return results
            finally: os.close(directory)
        raise ValueError("unknown workspace operation")
    finally: os.close(fd)

try:
    raw = sys.stdin.buffer.read(12*1024*1024+1)
    if len(raw)>12*1024*1024: raise ValueError("workspace request exceeds limit")
    print(json.dumps({"ok":True,"value":main(json.loads(raw))}))
except Exception as error:
    print(json.dumps({"ok":False,"error":str(error),"code":errno.errorcode.get(getattr(error,"errno",None),"EACCES")}))
