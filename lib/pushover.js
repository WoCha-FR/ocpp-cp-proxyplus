const axios = require('axios')

class Pushover {
  constructor(config) {
    this.userKey = config.userKey
    this.appToken = config.appToken
    this.payload = { token: this.appToken, user: this.userKey, message: '' }
  }

  resetPayload() {
    this.payload = { user: this.userKey, token: this.appToken, message: '' }
  }

  async send(title, message) {
    if (title) {
      this.payload.title = title
    }
    if (message) {
      this.payload.message = message
    }
    // Send the notification
    try {
      const response = await axios.post('https://api.pushover.net/1/messages.json', this.payload)
      return response.data
    } catch (error) {
      return { error: error.message }
    }
  }
}

module.exports = Pushover
