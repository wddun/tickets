import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const p12FilePath = './Certificates.p12';
const wwdrFilePath = './wwdr.cer';
const passCerPath = './pass.cer';
const password = process.env.PASS_CERT_PASSWORD;

async function convert() {
    try {
        console.log('--- Starting Certificate Conversion ---');

        // 1. Process P12 (Signer Cert + Key)
        const p12Buffer = fs.readFileSync(p12FilePath);
        const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

        // Get Signer Cert
        const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
        const certBag = bags[forge.pki.oids.certBag][0];
        const signerCertPem = forge.pki.certificateToPem(certBag.cert);
        fs.writeFileSync('./certs/signer.pem', signerCertPem);
        console.log('✅ Created certs/signer.pem');

        // Get Signer Key
        const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
        const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0];
        const signerKeyPem = forge.pki.privateKeyToPem(keyBag.key);
        fs.writeFileSync('./certs/signer.key', signerKeyPem);
        console.log('✅ Created certs/signer.key');

        // 2. Process WWDR CER
        const wwdrBuffer = fs.readFileSync(wwdrFilePath);
        const wwdrDer = wwdrBuffer.toString('binary');
        const wwdrAsn1 = forge.asn1.fromDer(wwdrDer);
        const wwdrCert = forge.pki.certificateFromAsn1(wwdrAsn1);
        const wwdrPem = forge.pki.certificateToPem(wwdrCert);
        fs.writeFileSync('./certs/wwdr.pem', wwdrPem);
        console.log('✅ Created certs/wwdr.pem');

        console.log('\n🎉 Conversion successful! All certs are in the /certs folder.');
    } catch (err) {
        console.error('❌ Error during conversion:', err.message);
        if (err.message.includes('Password')) {
            console.error('Hint: The password in your .env might be incorrect.');
        }
    }
}

convert();
