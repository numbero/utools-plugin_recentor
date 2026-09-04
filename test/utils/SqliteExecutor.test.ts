const mockFree = jest.fn()
const mockClose = jest.fn()
const mockGetAsObject = jest.fn(() => ({value: 'recent-project'}))
const mockStep = jest.fn()
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(false)
const mockPrepare = jest.fn(() => ({
    step: mockStep,
    getAsObject: mockGetAsObject,
    free: mockFree,
}))
const mockDatabase = jest.fn(() => ({
    prepare: mockPrepare,
    close: mockClose,
}))
const mockSqlInit = jest.fn(async (_config?: {wasmBinary?: ArrayBuffer}) => ({Database: mockDatabase}))

jest.mock('sql.js', () => ({
    __esModule: true,
    default: mockSqlInit,
}))

import {queryFromSqlite} from '../../src/utils/sqlite/SqliteExecutor'

test('loads sql.js WASM from the local package instead of fetching it', async () => {
    const rows = await queryFromSqlite(__filename, 'select value from ItemTable')

    expect(rows).toEqual([{value: 'recent-project'}])
    expect(mockSqlInit).toHaveBeenCalledTimes(1)
    expect(mockSqlInit).toHaveBeenCalledWith({
        wasmBinary: expect.any(ArrayBuffer),
    })
    expect(mockSqlInit.mock.calls[0][0]!.wasmBinary!.byteLength).toBeGreaterThan(0)
    expect(mockFree).toHaveBeenCalledTimes(1)
    expect(mockClose).toHaveBeenCalledTimes(1)
})
