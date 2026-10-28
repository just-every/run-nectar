import type { Bindings } from '../auth.server'
import { collectCustomerCertificate } from './certificates'
import { commit, guard, insist, newId, now, one, stmt } from './core'
import type { Input } from './input'
import { portalProfileAuthority, portalProfileFence, requirePortalProfileSession } from './portal-profile-authority'
import type { CustomerSession } from './portal-session'

/** A single scoped snapshot: no audit identities, review notes or other customers. */
export async function portalProfileData(env: Bindings, session: CustomerSession) {
  const authority = portalProfileAuthority(env, session)
  const row = await one(env, `SELECT c.name,c.billing_email,c.address,c.revision,
    (SELECT json_group_array(json_object('id',id,'name',name,'email',email,'revision',revision)) FROM
      (SELECT id,name,email,revision FROM nc_contacts WHERE customer_id=c.id AND role='billing' ORDER BY name,id)) AS contacts_json,
    (SELECT json_group_array(json_object('id',id,'type',type,'value',value,'status',status)) FROM
      (SELECT id,type,value,status FROM nc_customer_tax_ids WHERE customer_id=c.id ORDER BY type,id)) AS tax_ids_json,
    (SELECT json_group_array(json_object('id',id,'state',state,'reference',reference,'validFrom',valid_from,'expiresOn',expires_on,'filename',filename,'status',status,'collectedAt',collected_at)) FROM
      (SELECT id,state,reference,valid_from,expires_on,filename,status,collected_at FROM nc_certificates WHERE customer_id=c.id ORDER BY collected_at DESC,id)) AS certificates_json,
    EXISTS(SELECT 1 FROM nc_merchant_w9 WHERE singleton=1) AS merchant_w9
    FROM nc_customers c WHERE c.id=? AND ${authority.sql}`, session.customer, ...authority.params)
  insist(row, 'invalid_customer_session', 401)
  return {
    name: row.name as string, billingEmail: row.billing_email as string, address: row.address as string, revision: row.revision as string,
    contacts: JSON.parse(row.contacts_json) as { id: string; name: string; email: string; revision: string }[],
    taxIds: JSON.parse(row.tax_ids_json) as { id: string; type: string; value: string; status: 'unverified' }[],
    certificates: JSON.parse(row.certificates_json) as { id: string; state: string; reference: string; validFrom: string; expiresOn: string; filename: string; status: 'pending' | 'validated' | 'rejected'; collectedAt: number }[],
    merchantW9Available: !!row.merchant_w9,
  }
}

const fields: Record<string, string[]> = {
  address: ['revision', 'address'],
  'contact.add': ['name', 'email'],
  'contact.update': ['contact', 'revision', 'name', 'email'],
  'contact.remove': ['contact', 'revision'],
  'tax.add': ['type', 'value'],
  'tax.remove': ['tax'],
  'certificate.upload': ['state', 'reference', 'valid_from', 'expires_on', 'file'],
}

function contactInput(input: Input) {
  const name = input.text('name', { max: 120 }), email = input.text('email', { max: 200 }).toLowerCase()
  insist(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'invalid_email')
  return { name, email }
}

export async function operatePortalProfile(env: Bindings, session: CustomerSession, input: Input) {
  await requirePortalProfileSession(env, session)
  const operation = input.text('operation', { max: 40 })
  insist(Object.hasOwn(fields, operation), 'invalid_portal_profile_operation')
  input.only(['operation', ...fields[operation]])
  const identity = `customer:portal:${session.jti}`, customer = session.customer
  const statements: D1PreparedStatement[] = [portalProfileFence(env, session)]
  let subject = customer
  let result: Record<string, string> = {}
  if (operation === 'certificate.upload') {
    return collectCustomerCertificate(env, customer, identity, input, () => [portalProfileFence(env, session)])
  }
  if (operation === 'address') {
    const revision = input.text('revision', { max: 100 }), address = input.text('address', { max: 400, optional: true })
    const next = newId()
    statements.push(guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=?)', customer, revision),
      stmt(env, 'UPDATE nc_customers SET address=?,revision=?,updated_at=? WHERE id=?', address, next, now(), customer))
    result = { revision: next }
  } else if (operation === 'contact.add') {
    const { name, email } = contactInput(input), id = newId(), revision = newId()
    statements.push(stmt(env, "INSERT INTO nc_contacts(id,customer_id,name,email,role,created_by,created_at,revision) VALUES(?,?,?,?,'billing',?,?,?)", id, customer, name, email, identity, now(), revision))
    result = { contact: id, revision }
  } else if (operation === 'contact.update' || operation === 'contact.remove') {
    const id = input.text('contact', { max: 100 }), revision = input.text('revision', { max: 100 })
    subject = id
    statements.push(guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_contacts WHERE id=? AND customer_id=? AND role='billing' AND revision=?)", id, customer, revision))
    if (operation === 'contact.update') {
      const { name, email } = contactInput(input), next = newId()
      statements.push(stmt(env, "UPDATE nc_contacts SET name=?,email=?,revision=? WHERE id=? AND customer_id=? AND role='billing'", name, email, next, id, customer))
      result = { contact: id, revision: next }
    } else {
      statements.push(stmt(env, "DELETE FROM nc_contacts WHERE id=? AND customer_id=? AND role='billing'", id, customer))
      result = { contact: id }
    }
  } else if (operation === 'tax.add') {
    const type = input.text('type', { max: 40 }), value = input.text('value', { max: 200 }), id = newId()
    // Only the declared type and value are collected; no verification is implied.
    statements.push(stmt(env, 'INSERT INTO nc_customer_tax_ids(id,customer_id,type,value,created_at) VALUES(?,?,?,?,?)', id, customer, type, value, now()))
    result = { tax: id }
  } else if (operation === 'tax.remove') {
    const id = input.text('tax', { max: 100 })
    subject = id
    statements.push(guard(env, 'tax_id_not_found', 'EXISTS(SELECT 1 FROM nc_customer_tax_ids WHERE id=? AND customer_id=?)', id, customer),
      stmt(env, 'DELETE FROM nc_customer_tax_ids WHERE id=? AND customer_id=?', id, customer))
    result = { tax: id }
  }
  await commit(env, statements, { actor: identity, action: `portal.profile.${operation}`, subject, detail: { customer, ...result } })
  return { id: customer, ...result }
}
