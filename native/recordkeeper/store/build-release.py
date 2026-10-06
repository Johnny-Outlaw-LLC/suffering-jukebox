"""Build a signed Record Keeper bundle with credentials injected from Bitwarden."""
import base64,os,subprocess,tempfile,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1];android=root/'android'
required=['RK_ANDROID_KEYSTORE_B64','RK_ANDROID_STORE_PASSWORD','RK_ANDROID_KEY_PASSWORD','RK_ANDROID_KEY_ALIAS']
if any(not os.environ.get(name) for name in required):sys.exit('Inject the Record Keeper signing profile from Bitwarden before running this script.')
with tempfile.TemporaryDirectory(prefix='rk-release-') as temp:
    key=Path(temp)/'upload.jks';key.write_bytes(base64.b64decode(os.environ['RK_ANDROID_KEYSTORE_B64'],validate=True));key.chmod(0o600)
    env=os.environ.copy();env['RK_ANDROID_KEYSTORE']=str(key);env.pop('RK_ANDROID_KEYSTORE_B64',None)
    wrapper=str(android/('gradlew.bat' if os.name=='nt' else 'gradlew'))
    result=subprocess.run([wrapper,':app:bundleRelease',':app:assembleRelease','--console=plain'],cwd=android,env=env)
    sys.exit(result.returncode)
