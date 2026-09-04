import {Platform} from '../src/Types'
import {initShortcut, platformFromUtools} from '../src/Utils'
import Mousetrap from 'mousetrap'

test('get platform from utools', () => {
    expect<Platform>(platformFromUtools()).toEqual(Platform.darwin)
})

test('binds copy shortcuts with the macOS command modifier', () => {
    const bind = jest.spyOn(Mousetrap, 'bind').mockImplementation(() => undefined as any)

    initShortcut()

    expect(bind).toHaveBeenCalledWith('command+c', expect.any(Function))
    expect(bind).toHaveBeenCalledWith('command+b', expect.any(Function))
    expect(bind).not.toHaveBeenCalledWith('command+s+c', expect.any(Function))
    bind.mockRestore()
})
