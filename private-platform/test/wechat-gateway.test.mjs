import assert from 'node:assert/strict';
import test from 'node:test';
import {
  signGatewayRequest,
  verifyGatewaySignature,
  WechatGatewayClient
} from '../wechat-gateway.mjs';

test('gateway signature is stable and detects body changes', () => {
  const request = {
    method: 'POST',
    path: '/internal/v1/login-sessions',
    timestamp: '1720000000',
    nonce: 'abc',
    body: '{"appid":"wx-test"}'
  };
  const signature = signGatewayRequest('secret', request);
  assert.equal(signature, 'b270d02a8aa7ba5262776626d9df80616e2c61394550402afe0ead3e64861ecd');
  assert.equal(verifyGatewaySignature('secret', signature, request), true);
  assert.equal(verifyGatewaySignature('secret', signature, { ...request, body: '{}' }), false);
});

test('gateway client signs requests and unwraps data', async () => {
  let captured;
  const client = new WechatGatewayClient({
    baseUrl: 'https://wx.example.test',
    clientId: 'dump',
    clientSecret: 'secret',
    appId: 'wx-test'
  }, async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ data: {
      sessionId: 's1',
      mode: 'keyword',
      loginCode: '381729',
      qrCodeUrl: 'https://wx.example.test/fixed-qr.png'
    } }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    });
  });
  const result = await client.createLoginSession('browser-nonce');
  assert.equal(result.sessionId, 's1');
  assert.equal(result.mode, 'keyword');
  assert.equal(result.loginCode, '381729');
  assert.equal(result.qrCodeUrl, 'https://wx.example.test/fixed-qr.png');
  assert.equal(captured.url, 'https://wx.example.test/internal/v1/login-sessions');
  assert.equal(captured.options.headers['X-Client-Id'], 'dump');
  assert.match(captured.options.headers['X-Signature'], /^[a-f0-9]{64}$/);
});
