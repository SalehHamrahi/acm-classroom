export function isUniqueConstraint(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return code === '23505'
    || (code.includes('CONSTRAINT') && message.includes('unique'))
    || message.includes('unique constraint failed')
    || message.includes('violates unique constraint');
}
