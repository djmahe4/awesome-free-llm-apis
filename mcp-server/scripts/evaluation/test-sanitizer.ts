import { Sanitizer } from '../../src/utils/Sanitizer.js';

const code1 = 'self.client = genai.Client(api_key=os.getenv("KEY"))';
const code2 = 'self.client = genai.Client(api_key="AIzaSyA-RealKey-12345678")';

console.log('Original 1:', code1);
console.log('Sanitized 1:', Sanitizer.sanitize(code1));

console.log('\nOriginal 2:', code2);
console.log('Sanitized 2:', Sanitizer.sanitize(code2));
