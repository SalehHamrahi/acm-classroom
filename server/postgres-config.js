export function postgresEnvironmentFromUrl(connectionString, base = process.env) {
  let url;
  try { url = new URL(connectionString); }
  catch { throw new Error('DATABASE_URL معتبر نیست.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL باید از نوع postgresql:// باشد.');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database || !url.username) throw new Error('DATABASE_URL باید میزبان، نام پایگاه داده و کاربر را داشته باشد.');
  const env = {
    PATH: base.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: base.HOME || '/tmp',
    LANG: base.LANG || 'C.UTF-8',
  };
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || '5432';
  env.PGDATABASE = database;
  env.PGUSER = decodeURIComponent(url.username);
  env.PGPASSWORD = decodeURIComponent(url.password || '');
  const mappings = {
    sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY',
    connect_timeout: 'PGCONNECT_TIMEOUT', application_name: 'PGAPPNAME', target_session_attrs: 'PGTARGETSESSIONATTRS', options: 'PGOPTIONS',
  };
  for (const [parameter, variable] of Object.entries(mappings)) {
    if (url.searchParams.has(parameter)) env[variable] = url.searchParams.get(parameter);
  }
  if (!env.PGSSLMODE) env.PGSSLMODE = 'prefer';
  if (!env.PGCONNECT_TIMEOUT) env.PGCONNECT_TIMEOUT = '8';
  if (!env.PGAPPNAME) env.PGAPPNAME = 'acm-classroom';
  return env;
}
