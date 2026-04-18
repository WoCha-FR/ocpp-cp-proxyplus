const fs = require('fs')
const { getConfigFilePath } = require('./config')

function writeConfig(config) {
  const filePath = getConfigFilePath()
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
}

module.exports = { writeConfig }
