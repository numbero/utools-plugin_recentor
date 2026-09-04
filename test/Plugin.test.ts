import {readFileSync} from 'fs'
import {join} from 'path'
import {build} from '../src/Build'

interface PluginFeature {
    code: string
    cmds: Array<string | object>
}

const plugin = JSON.parse(readFileSync(join(__dirname, '../public/plugin.json'), 'utf8')) as {
    features: PluginFeature[]
}

test('every configured feature has a matching template export', () => {
    expect(Object.keys(build).sort()).toEqual(plugin.features.map(feature => feature.code).sort())
})

test('feature codes and text commands are unique', () => {
    const codes = plugin.features.map(feature => feature.code)
    const textCommands = plugin.features.flatMap(feature => feature.cmds.filter((cmd): cmd is string => typeof cmd === 'string'))

    expect(new Set(codes).size).toBe(codes.length)
    expect(new Set(textCommands.map(command => command.toLocaleLowerCase())).size).toBe(textCommands.length)
})
