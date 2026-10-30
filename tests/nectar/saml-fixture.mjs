import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const require = createRequire(createRequire(import.meta.url).resolve('@node-saml/node-saml'))

const { SignedXml } = require('xml-crypto')

export const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')

export async function samlFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nectar-idp-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key'), '-out', join(directory, 'cert'), '-subj', '/CN=synthetic-nectar-idp', '-days', '2'], { stdio: 'ignore' })
    const key = await readFile(join(directory, 'key'), 'utf8'), certificate = await readFile(join(directory, 'cert'), 'utf8')
    const issuer = 'https://idp.nectar.example.test', entry_point = issuer + '/saml'
    return { certificate, issuer, entry_point, sign({ requestId, callback, audience, email, subject = 'synthetic-nectar-1', role = 'billing', mfa = false, age = 0, recipient = callback }) {
      const at = Date.now() - age, instant = new Date(at).toISOString(), expires = new Date(at + 120000).toISOString()
      const assertionId = '_' + randomUUID(), responseId = '_' + randomUUID()
      let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${instant}" Destination="${escape(callback)}" InResponseTo="${requestId}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${instant}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID>${escape(subject)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${escape(recipient)}" NotOnOrAfter="${expires}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${instant}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${escape(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${instant}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${escape(email)}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="role"><saml:AttributeValue>${escape(role)}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="amr"><saml:AttributeValue>${mfa ? 'mfa pwd otp' : 'pwd'}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`
      for (const [name, id] of [['Assertion', assertionId], ['Response', responseId]]) {
        const signed = new SignedXml({ privateKey: key, publicCert: certificate, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' })
        signed.addReference({ xpath: `//*[@ID='${id}']`, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' })
        signed.computeSignature(xml, { location: { reference: `//*[local-name()='${name}']/*[local-name()='Issuer']`, action: 'after' } })
        xml = signed.getSignedXml()
      }
      return Buffer.from(xml).toString('base64')
    } }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export async function startSaml(h) {
  const start = await h.raw('/sso/start'), target = new URL(start.headers.get('location'))
  const xml = inflateRawSync(Buffer.from(target.searchParams.get('SAMLRequest'), 'base64')).toString()
  return { target, requestId: xml.match(/\bID="([^"]+)"/)[1], binding: start.headers.getSetCookie().map(line => line.split(';')[0]).join('; ') }
}

export async function postSaml(h, start, response) {
  return h.raw('/sso/acs', { form: new URLSearchParams({ RelayState: start.target.searchParams.get('RelayState'), SAMLResponse: response }) })
}
