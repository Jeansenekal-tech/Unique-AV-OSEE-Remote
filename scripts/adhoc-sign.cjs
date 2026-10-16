// electron-builder afterSign hook. Without a Developer ID certificate the app
// is left unsigned, and Apple Silicon refuses to launch unsigned apps
// ("app is damaged"). Ad-hoc sign it so it runs after "Open" / quarantine removal.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // properly signed
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
