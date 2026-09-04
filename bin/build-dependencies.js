const fs = require('fs')
const path = require('path')

const [root, target] = process.argv.slice(2)
if (!root || !target) {
  throw new Error('Need root and target paths')
}

const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const productionPackage = {
  name: `${source.name}-dependencies`,
  version: source.version,
  private: true,
  dependencies: source.dependencies || {},
}

fs.writeFileSync(
  path.join(target, 'package.json'),
  `${JSON.stringify(productionPackage, null, 2)}\n`,
  'utf8',
)
