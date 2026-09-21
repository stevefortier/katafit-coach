import hashlib, json, pathlib, shutil, subprocess, os
source = pathlib.Path(__file__).resolve().parents[1]
root = pathlib.Path(os.environ['KATAFIT_ACCEPTANCE_DIR']).resolve()
assert not root.exists(), 'Use a new evidence directory; existing data is never deleted'
assert not subprocess.check_output(['git','status','--porcelain'], cwd=source).strip(), 'Commit changes before creating the clean package fingerprint'
root.mkdir(parents=True)
snapshot = root / 'snapshot'
if snapshot.exists(): shutil.rmtree(snapshot)
snapshot.mkdir()
files = subprocess.check_output(['git','ls-files','-z'], cwd=source).decode().split('\0')
files += subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z','--','src','tests'], cwd=source).decode().split('\0')
hashes = {}
for name in filter(None, files):
    path = source / name
    if not path.is_file(): continue
    data = path.read_bytes()
    hashes[name] = hashlib.sha256(data).hexdigest()
    target = snapshot / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
fingerprint = {'head': subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip(), 'status': subprocess.check_output(['git','status','--short'],cwd=source,text=True), 'files':hashes}
(root/'source-fingerprint.json').write_text(json.dumps(fingerprint,indent=2)+'\n')
(snapshot/'node_modules').symlink_to(source/'node_modules', target_is_directory=True)
subprocess.run(['npm','run','build'],cwd=snapshot,check=True)
subprocess.run(['npm','pack','--ignore-scripts','--pack-destination',str(root)],cwd=snapshot,check=True)
(snapshot/'node_modules').unlink()
install=root/'installed'
if install.exists(): shutil.rmtree(install)
install.mkdir()
(install/'package.json').write_text('{"name":"standalone-backend-proof","private":true}')
subprocess.run(['npm','install','--omit=dev','--ignore-scripts','--no-audit','--no-fund',str(root/'katafit-coach-0.1.0.tgz')],cwd=install,check=True)
print(json.dumps({'head':fingerprint['head'],'source_files':len(hashes),'tar_sha256':hashlib.sha256((root/'katafit-coach-0.1.0.tgz').read_bytes()).hexdigest()}))
