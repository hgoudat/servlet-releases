"""Import ephemeral runner credentials without printing secrets or command arguments."""
import base64
import os
from pathlib import Path
import re
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

def notarization_failure(result):
    # Match provider responses privately and return only fixed diagnostic text.
    output = (result.stdout + result.stderr).decode("utf-8", errors="replace").lower()
    if re.search(r"http (?:status(?: code)?[: ]*|error[: ]*)401\b", output) or "invalid credentials" in output:
        return "Apple rejected notarization authentication (HTTP 401). Check APPLE_ID and an app-specific password for that same account."
    if re.search(r"http (?:status(?: code)?[: ]*|error[: ]*)403\b", output):
        return "Apple rejected notarization access (HTTP 403). Check access to the configured developer team."
    if "agreement" in output:
        return "Apple requires attention to the developer account agreement before notarization."
    if any(text in output for text in ["error storing", "error saving", "failed to save", "specified keychain", "specified logon session"]):
        return "macOS could not store the notarization profile in the temporary Keychain."
    if any(text in output for text in ["timed out", "connection", "resolve host", "nsurlerrordomain"]):
        return "The runner could not connect to Apple's notarization service."
    if re.search(r"http (?:status(?: code)?[: ]*|error[: ]*)5\d\d\b", output):
        return "Apple's notarization service returned a server error."
    return "Notarization credential validation failed with an unclassified provider response. Private response contents were withheld."

def run(args, *, allow_existing_certificate=False):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        if (
            allow_existing_certificate
            and args[:2] == ["security", "import"]
            and result.returncode == 1
            and result.stderr.strip()
            == b"security: SecKeychainItemImport: The specified item already exists in the keychain."
        ):
            return
        if args[:3] == ["xcrun", "notarytool", "store-credentials"]:
            raise SystemExit(notarization_failure(result))
        operation = " ".join(args[:2])
        raise SystemExit(f"Credential setup failed during {operation}. Check certificate and notarization credentials.")

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
run(["security", "import", str(intermediate), "-k", str(keychain)], allow_existing_certificate=True)
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
    args += ["--apple-id", required("APPLE_ID").strip(), "--team-id", required("APPLE_TEAM_ID").strip(), "--password", required("APPLE_APP_SPECIFIC_PASSWORD").strip()]
run(args)
print("Temporary signing identity and notarization profile validated.")
