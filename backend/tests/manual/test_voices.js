import { GoogleTtsService } from '../../tts/ttsService.js';

async function testVoices() {
  const service = new GoogleTtsService();
  try {
    const voices = await service.listVoices();
    console.log('Total voices:', voices.length);

    // Filter Japanese voices
    const jaVoices = voices.filter(v => v.languageCodes && v.languageCodes.includes('ja-JP'));
    console.log('Japanese voices:', jaVoices.map(v => v.name));

    // Filter Chinese voices
    const zhVoices = voices.filter(v => v.languageCodes && v.languageCodes.includes('zh-CN'));
    console.log('Chinese voices:', zhVoices.map(v => v.name));

    // Filter Neural2 voices for Japanese
    const jaNeural2 = await service.findVoicesForLanguageAndTier('ja-JP', 'neural2');
    console.log('Japanese Neural2 voices:', jaNeural2);

    // Filter Neural2 voices for Chinese
    const zhNeural2 = await service.findVoicesForLanguageAndTier('zh-CN', 'neural2');
    console.log('Chinese Neural2 voices:', zhNeural2);

  } catch (error) {
    console.error('Error:', error.message);
  }
}

testVoices();
