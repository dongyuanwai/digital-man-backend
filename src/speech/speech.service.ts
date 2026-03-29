/**
 * SpeechService
 * - 封装与腾讯云 ASR 的交互
 * - 暴露单句识别能力：recognizeBySentence
 */
import { Inject, Injectable } from '@nestjs/common';
import type * as tencentcloud from 'tencentcloud-sdk-nodejs';

type UploadedAudio = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

type AsrClient = InstanceType<typeof tencentcloud.asr.v20190614.Client>;

@Injectable()
export class SpeechService {
  constructor(@Inject('ASR_CLIENT') private readonly asrClient: AsrClient) {}

  async recognizeBySentence(file: UploadedAudio): Promise<string> {
    // 腾讯云接口要求 Base64 编码数据
    const audioBase64 = file.buffer.toString('base64');

    const result = await this.asrClient.SentenceRecognition({
      // 识别服务类型：16k 采样率中文模型
      EngSerViceType: '16k_zh',
      // 数据来源：1 表示音频数据直接上传（非 URL）
      SourceType: 1,
      // Base64 编码后的音频数据
      Data: audioBase64,
      // 原始音频字节长度
      DataLen: file.buffer.length,
      // 音频格式：此项目默认使用 OGG 封装的 OPUS 编码
      VoiceFormat: 'ogg-opus',
    });

    // 返回识别文本（为空时兜底空串）
    return result.Result ?? '';
  }
}
