# Firebase Admin service-account key rotation runbook

Status: operator procedure only. No key, Render variable or deployment was changed.

Target identity:
`firebase-adminsdk-fbsvc@menrosystem-ddfac.iam.gserviceaccount.com` in project
`menrosystem-ddfac`. Rotating a key on this same identity does not require changing its
runtime IAM roles. The human/operator creating and later disabling/deleting keys needs
the corresponding service-account key-management permissions (normally through the
reviewed Service Account Key Admin role); do not grant those permissions to the MENRO
runtime merely to rotate its key. Existing runtime Auth/Firestore permissions and the
separately reviewed bucket permissions must remain unchanged during rotation.

1. Confirm the running project and displayed service-account email match the production
   allowlist. Record the current successful Render deploy ID and a rollback owner.
2. In Google Cloud IAM -> Service Accounts -> the exact account -> Keys, create one new
   JSON user-managed key on that exact existing service
   account. Use the approved secret channel; never display, paste into chat, or commit
   the JSON/private-key material. Allow for key propagation before verification. Do not
   disable the old key.
3. In Render Dashboard -> `menroBK-1` -> Environment, change only
   `FIREBASE_PRIVATE_KEY`. Preserve `FIREBASE_PROJECT_ID` and
   `FIREBASE_CLIENT_EMAIL`; do not add GCS activation variables. Save through a
   separately approved zero-downtime deployment.
4. Require the new instance to become healthy. Verify login/session validation and one
   bounded existing Firebase Admin Auth/Firestore operation. Confirm non-secret Cloud
   audit evidence identifies the non-secret new service-account key ID/name on the
   expected service account. Record only that ID, timestamps and boolean results. This
   is the runtime-identity attestation checkpoint.
5. If startup or verification fails, restore the old Render secret and redeploy before
   changing key state in Google Cloud. Investigate without printing credentials.
6. After a documented monitoring window with no old-key use, disable—not delete—the old
   key. Monitor service health and Cloud audit evidence again. Re-enable it if a verified
   dependency still uses it.
7. After the second monitoring window and dependency-owner approval, delete the old key.
   Deletion is irreversible. Record key IDs, timestamps and approvals only.

Do not combine this operation with application changes, request-identification key
rotation, IAM changes, PAP/UBLA changes or Firebase Storage activation.
