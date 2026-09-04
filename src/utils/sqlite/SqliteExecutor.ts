import {readFileSync} from 'fs'
import {isEmpty, isNil} from 'licia'
import sqlInit, {Database, Statement} from 'sql.js'

let SQL

const initSqlJs = async () => {
    // uTools preload runs with both DOM and Node globals. sql.js therefore tries
    // to fetch its WASM file like a browser asset, which fails under file://.
    // Supplying the bytes directly keeps loading entirely in the Node context.
    const wasmFile = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))
    const wasmBinary = new Uint8Array(wasmFile).buffer
    return sqlInit({wasmBinary})
}

export const queryFromSqlite: (databaseFilePath: string, sql: string) => Promise<Array<any>> = async (databaseFilePath, sql) => {
    if (isEmpty(databaseFilePath)) return []
    if (isNil(SQL)) SQL = await initSqlJs()
    let database: Database | undefined, statement: Statement | undefined
    try {
        database = new SQL.Database(readFileSync(databaseFilePath))
        statement = database!.prepare(sql)
        let result: Array<any> = []
        while (statement.step()) {
            result.push(statement.getAsObject())
        }
        return result
    } finally {
        if (!isNil(statement))
            statement!.free()
        if (!isNil(database))
            database!.close()
    }
    return []
}
