import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
// Read from stdin so the password never appears in shell history or command arguments.
const rl=createInterface({input:stdin,output:stdout,terminal:false});
const password=await rl.question('');rl.close();
if(password.length<16){console.error('Password must contain at least 16 characters');process.exit(1);}
const salt=randomBytes(16).toString('hex');console.log(`${salt}:${scryptSync(password,salt,32).toString('hex')}`);
