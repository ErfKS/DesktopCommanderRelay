import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  VisionBridgeError,
  extractImagePayload,
  extractOpenAiResponseText,
  normalizeVisionDetail,
  parseVisionDeviceIds,
  validateVisionPath,
} from '../src/server/vision-bridge.js';

test(
  'parses and normalizes Vision Bridge device ids',
  () => {
    assert.deepEqual(
      [
        ...parseVisionDeviceIds(
          ' Home-PC-Sandbox , webdade ',
        ),
      ],
      [
        'home-pc-sandbox',
        'webdade',
      ],
    );
  },
);

test(
  'accepts supported mounted image paths',
  () => {
    assert.equal(
      validateVisionPath(
        '/projects/dadehban-infographic/cover.jpg',
      ),
      '/projects/dadehban-infographic/cover.jpg',
    );

    assert.equal(
      validateVisionPath(
        '/workspace/example.png',
      ),
      '/workspace/example.png',
    );
  },
);

test(
  'rejects unsafe or unsupported Vision paths',
  () => {
    for (
      const invalid of [
        'https://example.com/image.png',
        '/etc/passwd.png',
        '/projects/app/../secret.png',
        'C:\\Users\\example\\image.png',
        '/projects/app/image.svg',
      ]
    ) {
      assert.throws(
        () =>
          validateVisionPath(
            invalid,
          ),
        VisionBridgeError,
      );
    }
  },
);

test(
  'accepts only supported image detail values',
  () => {
    assert.equal(
      normalizeVisionDetail(undefined),
      'high',
    );

    assert.equal(
      normalizeVisionDetail('LOW'),
      'low',
    );

    assert.equal(
      normalizeVisionDetail('auto'),
      'auto',
    );

    assert.throws(
      () =>
        normalizeVisionDetail(
          'original',
        ),
      VisionBridgeError,
    );
  },
);

test(
  'extracts native MCP image content',
  () => {
    const bytes =
      Buffer.from(
        'native-image-test',
      );

    const data =
      bytes.toString('base64');

    const result =
      extractImagePayload(
        {
          content: [
            {
              type: 'text',
              text: 'Image file',
            },
            {
              type: 'image',
              data,
              mimeType:
                'image/jpeg',
            },
          ],
        },
        1024,
      );

    assert.equal(
      result.mimeType,
      'image/jpeg',
    );

    assert.equal(
      result.data,
      data,
    );

    assert.equal(
      result.bytes,
      bytes.length,
    );
  },
);

test(
  'extracts structured image data URL',
  () => {
    const bytes =
      Buffer.from(
        'structured-image-test',
      );

    const data =
      bytes.toString('base64');

    const result =
      extractImagePayload(
        {
          structuredContent: {
            imageData:
              `data:image/png;base64,${data}`,
          },
        },
        1024,
      );

    assert.equal(
      result.mimeType,
      'image/png',
    );

    assert.equal(
      result.data,
      data,
    );

    assert.equal(
      result.bytes,
      bytes.length,
    );
  },
);

test(
  'rejects images over configured byte limit',
  () => {
    const data =
      Buffer
        .alloc(128, 1)
        .toString('base64');

    assert.throws(
      () =>
        extractImagePayload(
          {
            content: [
              {
                type: 'image',
                data,
                mimeType:
                  'image/png',
              },
            ],
          },
          64,
        ),
      VisionBridgeError,
    );
  },
);

test(
  'extracts text from Responses API response',
  () => {
    const text =
      extractOpenAiResponseText(
        {
          output: [
            {
              type: 'message',
              content: [
                {
                  type:
                    'output_text',
                  text:
                    'The image contains a dashboard.',
                },
              ],
            },
          ],
        },
      );

    assert.equal(
      text,
      'The image contains a dashboard.',
    );
  },
);
