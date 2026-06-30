// send.js
const { sendEmails } = require('./server');
const recipients = require('./recipients');

(async function sendCampaign() {
  console.log(`📨 Sending to ${recipients.length} recipients...`);
  console.log('⏳ This may take a few moments...\n');
  
  try {
    const results = await sendEmails(recipients);
    
    console.log('\n📊 Summary:');
    console.log(`✅ Successfully sent: ${results.filter(r => r.status === 'sent').length}`);
    console.log(`❌ Failed: ${results.filter(r => r.status === 'failed').length}`);
    
    console.log('\n📋 Check results at: http://localhost:3000/dashboard');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('\nPlease configure your SMTP settings in the dashboard first.');
  }
})();