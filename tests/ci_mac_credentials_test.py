import base64
import contextlib
import io
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/ci-mac-credentials.py"
DUPLICATE = b"security: SecKeychainItemImport: The specified item already exists in the keychain.\n"


class CredentialImportTests(unittest.TestCase):
    def execute(self, failing_file=None, error=DUPLICATE, notary_error=None):
        self.commands = []
        output = io.StringIO()

        def command(args, **kwargs):
            self.commands.append(args)
            if args[:3] == ["xcrun", "notarytool", "store-credentials"] and notary_error:
                return subprocess.CompletedProcess(args, 1, notary_error, b"")
            failed = (
                args[:2] == ["security", "import"]
                and Path(args[2]).name == failing_file
            )
            return subprocess.CompletedProcess(args, int(failed), b"", error if failed else b"")

        with tempfile.TemporaryDirectory() as folder:
            environment = {
                "RUNNER_TEMP": folder,
                "APPLE_CERTIFICATE_BASE64": base64.b64encode(b"certificate fixture").decode(),
                "APPLE_CERTIFICATE_PASSWORD": "private-certificate-password",
                "APPLE_ID": "  private-apple-id@example.invalid\n",
                "APPLE_TEAM_ID": "8V3C66NC5Z",
                "APPLE_APP_SPECIFIC_PASSWORD": "  private-notary-password\n",
                "APPLE_NOTARY_AUTH": "apple-id",
            }
            with (
                patch.dict(os.environ, environment, clear=True),
                patch("subprocess.run", side_effect=command),
                patch("urllib.request.urlopen", return_value=io.BytesIO(b"intermediate fixture")),
                contextlib.redirect_stdout(output),
            ):
                runpy.run_path(str(SCRIPT))
            self.assertEqual((Path(folder) / "servlet-signing.p12").stat().st_mode & 0o777, 0o600)
        self.assertNotIn("private-", output.getvalue())
        return output.getvalue()

    def test_success_validates_notarization(self):
        self.assertIn("validated", self.execute())
        self.assertEqual(self.commands[-1][:3], ["xcrun", "notarytool", "store-credentials"])

    def test_existing_apple_intermediate_does_not_block_signing_setup(self):
        self.assertIn("validated", self.execute("servlet-developer-id-g2.cer"))
        self.assertEqual(self.commands[-1][0], "xcrun")

    def test_other_intermediate_errors_are_fatal_and_do_not_expose_provider_output(self):
        with self.assertRaises(SystemExit) as failure:
            self.execute("servlet-developer-id-g2.cer", b"private-provider-error")
        self.assertIn("security import", str(failure.exception))
        self.assertNotIn("private-", str(failure.exception))
        self.assertFalse(any(args[0] == "xcrun" for args in self.commands))

    def test_duplicate_signing_identity_is_not_silently_accepted(self):
        with self.assertRaises(SystemExit):
            self.execute("servlet-signing.p12")
        self.assertFalse(any(args[0] == "xcrun" for args in self.commands))

    def test_apple_authentication_failure_does_not_expose_private_response(self):
        with self.assertRaises(SystemExit) as failure:
            self.execute(notary_error=b"Error: HTTP status code: 401. Invalid credentials. private-apple-id@example.invalid private-notary-password")
        self.assertIn("HTTP 401", str(failure.exception))
        self.assertNotIn("private-", str(failure.exception))

    def test_apple_team_access_failure_is_distinct_from_authentication(self):
        with self.assertRaises(SystemExit) as failure:
            self.execute(notary_error=b"Error: HTTP status code: 403. private-response")
        self.assertIn("HTTP 403", str(failure.exception))
        self.assertNotIn("private-", str(failure.exception))

    def test_network_failure_is_distinct_from_authentication(self):
        with self.assertRaises(SystemExit) as failure:
            self.execute(notary_error=b"NSURLErrorDomain: The connection timed out. private-response")
        self.assertIn("could not connect", str(failure.exception))
        self.assertNotIn("private-", str(failure.exception))

    def test_unknown_provider_output_stays_private(self):
        with self.assertRaises(SystemExit) as failure:
            self.execute(notary_error=b"private-unexpected-provider-response")
        self.assertIn("unclassified", str(failure.exception))
        self.assertNotIn("private-", str(failure.exception))

    def test_secret_paste_whitespace_is_removed_before_validation(self):
        self.execute()
        args = self.commands[-1]
        self.assertEqual(args[args.index("--apple-id") + 1], "private-apple-id@example.invalid")
        self.assertEqual(args[args.index("--password") + 1], "private-notary-password")


if __name__ == "__main__":
    unittest.main()
