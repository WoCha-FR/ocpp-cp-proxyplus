const nodemailer = require('nodemailer')

class Mailer {
  constructor(config) {
    this.config = config
    this.transporter = null
    this.init()
  }

  init() {
    this.transporter = nodemailer.createTransport(this.config.transporter)
  }

  async send(title, message) {
    const htmlMessage = message.replace(/\n/g, '<br>')
    const mailOptions = { from: this.config.from, to: this.config.to, subject: title, text: message, html: htmlMessage }
    try {
      const response = await this.transporter.sendMail(mailOptions)
      return response
    } catch (error) {
      return { error: error.message }
    }
  }
}

module.exports = Mailer
