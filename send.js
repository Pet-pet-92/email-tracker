// send.js
const { sendEmails } = require('./server');
const recipients = require('./recipients');

(async function sendCampaign() {
  console.log(` Sending to ${recipients.length} recipients...`);
  console.log(' This may take a few moments...\n');
  
  const results = await sendEmails(recipients);
  
  console.log('\n Summary:');
  console.log(`Successfully sent: ${results.filter(r => r.status === 'sent').length}`);
  console.log(` Failed: ${results.filter(r => r.status === 'failed').length}`);
  
  console.log('\n Check results at: http://localhost:3000/dashboard');
})();