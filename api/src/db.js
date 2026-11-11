const sql = require('mssql');

let poolPromise;
function getPool() {
  if (!poolPromise) {
    const cs = process.env.SQL_CONNECTION_STRING;
    if (!cs) throw new Error('SQL_CONNECTION_STRING is not set');
    poolPromise = new sql.ConnectionPool(cs).connect().catch(err => {
      poolPromise = undefined;
      throw err;
    });
  }
  return poolPromise;
}

async function query(text, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [name, [type, value]] of Object.entries(params)) req.input(name, type, value);
  const result = await req.query(text);
  return result.recordset;
}

function json(body, status = 200) {
  return { status, jsonBody: body, headers: { 'Cache-Control': 'no-store' } };
}

function fail(context, err) {
  context.error(err);
  return json({ error: 'Something went wrong talking to the database.' }, 500);
}

module.exports = { sql, query, json, fail };
