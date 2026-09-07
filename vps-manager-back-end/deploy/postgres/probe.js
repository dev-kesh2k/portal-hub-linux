require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: 'postgres',
});

client
  .connect()
  .then(() => client.query('SELECT current_user, inet_server_addr() AS addr, inet_server_port() AS port'))
  .then((r) => {
    console.log('pg-ok', r.rows[0]);
    return client.end();
  })
  .catch((err) => {
    console.error('pg-fail', err.message);
    process.exit(1);
  });
