// OTP delivery. In India, commercial SMS needs DLT registration: register your sender ID and OTP template first.
import { config } from './config.js';

export async function sendOtp(phone10, code) {
  switch (config.smsProvider) {
    case 'console':
      console.log(`[otp] +91${phone10} -> ${code}`);
      return;
    case 'msg91': {
      const params = new URLSearchParams({ template_id: config.msg91TemplateId, mobile: `91${phone10}`, otp: code });
      const res = await fetch(`https://control.msg91.com/api/v5/otp?${params}`, {
        method: 'POST', headers: { authkey: config.msg91AuthKey }, signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`MSG91 ${res.status}`);
      return;
    }
    case 'twilio': {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: 'Basic ' + Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64') },
        body: new URLSearchParams({ To: `+91${phone10}`, From: config.twilioFrom, Body: `${code} is your Loans24 verification code. It expires in 5 minutes. Do not share it.` }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Twilio ${res.status}`);
      return;
    }
    default:
      throw new Error(`Unknown SMS_PROVIDER "${config.smsProvider}"`);
  }
}
