Open Settings, Access, then Enterprise sign-in and provisioning. Only the owner
may authorize the connection, with the current GOV-007 fresh-factor requirement.
Enter the provider issuer, HTTPS SAML sign-in URL, public signing certificate,
and explicit JSON role mappings. For example, `{"billing":"accountant"}` maps
the provider's billing group to Nectar's accountant role. Unknown roles are
denied. Owner and custom roles cannot be provisioned through this connection.

Configure the provider's audience and reply URL using the values shown on the
page. Use the immutable provider user ID as SAML NameID. Include signed `email`
and `role` attributes. Okta can include the actual authentication methods in a
dynamic `amr` attribute using `session.amr`. A static password authentication
class never proves MFA. Nectar accepts an actual signed `mfa` method or the
recognized REFEDS MFA, TimeSyncToken or SmartcardPKI class. Both the assertion
and the response must be signed with the configured certificate. Sign-in is
initiated at `/sso/start`; unsolicited assertions are refused.

Saving authorizes this connection and returns its provisioning bearer
credential once. Keep it in the provider's secret store. Nectar stores only its
SHA-256 fingerprint. Connection settings, SCIM bindings and pending sign-ins are excluded from
archives; a restored installation needs fresh owner authorization.
Saving again rotates the credential, discards pending
sign-ins and ends enterprise sessions. The issuer and existing role mappings
cannot be reassigned while provisioned identities exist.

The SCIM endpoint is `/scim/v2`. Create a User with `externalId` equal to the
immutable provider user ID, `userName` equal to the email, `active: true`, and
one `roles` value matching an explicit role mapping. Existing owner or member
accounts cannot be taken over or matched by email. User reads and exact
`userName eq "email"` or `externalId eq "id"` filters are available to the
provisioning credential. Replace the `active` property with false through SCIM
PATCH, or delete the User, to end access. Reactivation preserves the immutable
identity and does not restore old sessions. Identity reassignment and role
changes through SCIM are refused.

Provisioned members sign in with their provider. The SAML assertion must match
their immutable ID, email and mapped role. Each sign-in is correlated to a
short-lived request, consumed once and completed in the initiating browser.
Deprovisioning ends existing native sessions on the next request and fences
in-flight sign-ins. Required MFA is checked before a session is returned. The
signed authentication time supplies GOV-007 freshness, rather than arrival
time. The separate payment-method setup rule still requires a local TOTP or
passkey, as specified by its 26 October ruling.

Ct approved the connection, role and MFA policy with riders on 26 October 2026.
This policy approval establishes no live provider qualification or completed GOV-003 claim. Local public-door proof is
`tests/nectar/enterprise-identity.mjs` (`enterpriseIdentityFlow`). Its native
connection screens are exercised by
`tests/nectar/enterprise-identity-browser.mjs`. The separately invoked
`tests/nectar/enterprise-identity-sandbox.mjs` uses held Okta credentials,
creates only temporary Nectar identities and removes its user, app and group.
It prints a secret-free outcome and never persists provider assertions.


An active existing member in a non-owner preset role can now open Sign-in
security and choose Prove provider identity. Keep the current Nectar session
open through the signed provider round trip. Nectar checks that the authorized
provider role agrees with the existing role, then holds an exact request for
at most five minutes. Email equality is never enough to link accounts.

The owner opens Enterprise sign-in under Access, reviews the exact member,
provider issuer and immutable subject, connection revision and role, confirms
a second factor, then chooses Approve member link. This approval always needs
a fresh factor, including when the general MFA policy is off. It preserves the
member and operator identifiers and all historical attribution, while ending
old sessions and unused email sign-in links. Audit failure changes nothing.

Pending requests are inactive SCIM reservations: the provider may read or
remove them, but activation cannot grant access. Provider removal invalidates
the pending proof; owner connection authorization must be renewed before that
subject can be requested again. Connection or member changes and expired
proofs invalidate approval. Neither reactivation nor archive restoration
revives enterprise sessions or pending requests. The linking and real archive
journeys are in `tests/nectar/enterprise-linking.mjs`; linking mode in
`tests/nectar/enterprise-identity-browser.mjs` exercises the native approval.
Owner provisioning, custom-role mappings, broader administration and
live interoperability for every named provider remain required and unproved.
Native OIDC connection and sign-in custody is documented in the Enterprise
OIDC connection section of `API.md`; its signed-token journey is
`tests/nectar/enterprise-oidc.mjs` (`enterpriseOidcFlow`). The owner Settings
page identifies that protocol and its callback without offering a SAML form.
OIDC proofs and connection records are installation-bound; real archive
restoration is exercised by the OIDC archive mode in
`tests/nectar/enterprise-linking.mjs`. These fixtures establish no authentic
Okta or other named-provider interoperability.
