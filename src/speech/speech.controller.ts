/**
 * SpeechController
 * - 对外提供语音相关的 HTTP 接口
 * - 当前包含：音频文件单句识别（/speech/asr）
 */
import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SpeechService } from './speech.service';

@Controller('speech')
export class SpeechController {
  constructor(private readonly speechService: SpeechService) {}

  @Post('asr')
  // 使用文件上传拦截器处理 multipart/form-data 上传；字段名为 audio
  @UseInterceptors(FileInterceptor('audio'))
  async recognize(
    // 从请求中提取上传的文件对象
    @UploadedFile()
    file?: {
      buffer: Buffer;
      originalname: string;
      mimetype: string;
      size: number;
    },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        '请通过 FormData 的 audio 字段上传音频文件',
      );
    }

    // 调用服务进行识别，返回识别文本
    const text = await this.speechService.recognizeBySentence(file);
    return { text };
  }
}
