const net = require('net');

const HOST = '10.10.10.64';
const PORT = 4196;

function crc16(buf) {
    let crc = 0xFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
    }
    return crc;
}

function withCRC(buf) {
    const out = Buffer.alloc(buf.length + 2);
    buf.copy(out);
    out.writeUInt16LE(crc16(buf), buf.length);
    return out;
}

// Test: try connecting and sending various Modbus frames
async function test(label, frame, timeoutMs = 3000) {
    return new Promise((resolve) => {
        console.log(`\n${label}`);
        console.log(`  Sending: ${frame.toString('hex')}`);
        const socket = new net.Socket();
        let done = false;

        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                console.log('  ✗ No response (timeout)');
                socket.destroy();
                resolve(null);
            }
        }, timeoutMs);

        socket.connect(PORT, HOST, () => {
            console.log('  Connected, writing...');
            socket.write(frame);
        });

        socket.on('data', (data) => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                console.log(`  ✓ Response (${data.length} bytes): ${data.toString('hex')}`);
                socket.end();
                resolve(data);
            }
        });

        socket.on('error', (err) => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                console.log(`  ✗ Error: ${err.message}`);
                resolve(null);
            }
        });
    });
}

async function run() {
    console.log(`Diagnosing Waveshare relay at ${HOST}:${PORT}`);
    console.log('='.repeat(50));

    // 1. RTU Read Coils, Unit ID 1
    const rtu1 = withCRC(Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x08]));
    await test('RTU Read Coils (Unit 1)', rtu1);

    // 2. RTU Read Coils, Unit ID 0  
    const rtu0 = withCRC(Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x08]));
    await test('RTU Read Coils (Unit 0)', rtu0);

    // 3. RTU Read Coils, Unit ID 255
    const rtu255 = withCRC(Buffer.from([0xFF, 0x01, 0x00, 0x00, 0x00, 0x08]));
    await test('RTU Read Coils (Unit 255)', rtu255);

    // 4. Modbus TCP Read Coils, Unit ID 1
    const tcp1 = Buffer.from([
        0x00, 0x01, // Transaction ID
        0x00, 0x00, // Protocol ID
        0x00, 0x06, // Length
        0x01,       // Unit ID
        0x01,       // FC: Read Coils
        0x00, 0x00, // Start addr
        0x00, 0x08  // Quantity
    ]);
    await test('TCP Read Coils (Unit 1)', tcp1);

    // 5. Modbus TCP Read Coils, Unit ID 0
    const tcp0 = Buffer.from([
        0x00, 0x02, 0x00, 0x00, 0x00, 0x06,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x08
    ]);
    await test('TCP Read Coils (Unit 0)', tcp0);

    // 6. RTU Write Coil ON (ch1), Unit ID 1 — the classic Waveshare example
    const writeOn = withCRC(Buffer.from([0x01, 0x05, 0x00, 0x00, 0xFF, 0x00]));
    await test('RTU Write Coil ON CH1 (Unit 1)', writeOn);

    // 7. RTU Read DI (FC02), Unit ID 1
    const readDI = withCRC(Buffer.from([0x01, 0x02, 0x00, 0x00, 0x00, 0x08]));
    await test('RTU Read DI (Unit 1, FC02)', readDI);

    // 8. Try Waveshare protocol V2 (some boards use a proprietary protocol)
    // Custom frame: MA0 MA1 LEN CMD DATA CS
    // Read all relays: 0xFE 0xFE 0x01 0x12
    const wsProto = Buffer.from([0xFE, 0xFE, 0x00, 0x01, 0x00, 0x12, 0x00, 0x13]);
    await test('Waveshare Protocol V2 (read relays)', wsProto);

    console.log('\n' + '='.repeat(50));
    console.log('Diagnostics complete.');
    process.exit(0);
}

run();
