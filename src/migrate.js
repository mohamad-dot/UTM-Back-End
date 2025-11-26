import fs from 'fs'
import path from 'path'
import { pool } from './db.js'

async function main(){
  const sqlPath = path.resolve(process.cwd(), 'migrations', '001_geo.sql')
  const raw = fs.readFileSync(sqlPath, 'utf-8')
  const statements = raw.split(/;\s*\n/).filter(s => s.trim().length)
  const conn = await pool.getConnection()
  try {
    console.log('Running migration 001_geo.sql...')
    for (const stmt of statements){
      await conn.query(stmt)
    }
    console.log('Migration complete.')
  } finally {
    conn.release()
    await pool.end()
  }
}
main().catch(err => { console.error(err); process.exit(1) })
