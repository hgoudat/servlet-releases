"""Import ephemeral runner credentials without printing secrets or command arguments."""
import base64
import os
from pathlib import Path
import secrets
import subprocess
import urllib.request

root = Path(os.environ["RUNNER_TEMP"])
keychain = root / "servlet.keychain-db"

def required(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing GitHub environment setting: {name}")
    return value

def run(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise SystemExit(f"Credential setup failed in {args[0]}. Check certificate and notarization credentials.")

certificate = root / "servlet-signing.p12"
certificate.write_bytes(base64.b64decode(required("APPLE_CERTIFICATE_BASE64"), validate=True))
certificate.chmod(0o600)
password = secrets.token_hex(32)
run(["security", "create-keychain", "-p", password, str(keychain)])
run(["security", "set-keychain-settings", "-lut", "7200", str(keychain)])
run(["security", "unlock-keychain", "-p", password, str(keychain)])
run(["security", "import", str(certificate), "-P", required("APPLE_CERTIFICATE_PASSWORD"), "-T", "/usr/bin/codesign", "-t", "cert", "-f", "pkcs12", "-k", str(keychain)])
intermediate = root / "servlet-developer-id-g2.cer"
with urllib.request.urlopen("https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer", timeout=30) as response:
    intermediate.write_bytes(response.read())
run(["security", "import", str(intermediate), "-k", str(keychain)])
run(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, str(keychain)])
run(["security", "list-keychains", "-d", "user", "-s", str(keychain)])
run(["security", "default-keychain", "-d", "user", "-s", str(keychain)])
# CI supports the Apple ID route selected by the owner. API keys can be used
# instead by setting APPLE_NOTARY_AUTH=api-key and the corresponding secrets.
args = ["xcrun", "notarytool", "store-credentials", "servlet-ci", "--keychain", str(keychain)]
if (os.environ.get("APPLE_NOTARY_AUTH") or "apple-id") == "api-key":
    api_key = root / "servlet-notary.p8"
    api_key.write_bytes(base64.b64decode(required("APPLE_API_KEY_BASE64"), validate=True))
    api_key.chmod(0o600)
    args += ["--key", str(api_key), "--key-id", required("APPLE_API_KEY_ID"), "--issuer", required("APPLE_API_ISSUER")]
else:
    args += ["--apple-id", required("APPLE_ID"), "--team-id", required("APPLE_TEAM_ID"), "--password", required("APPLE_APP_SPECIFIC_PASSWORD")]
run(args)
print("Temporary signing identity and notarization profile validated.")
