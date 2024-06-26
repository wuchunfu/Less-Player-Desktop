import EventBus from '../common/EventBus';
import Hls from 'hls.js';
import { WebAudioApi } from './WebAudioApi';
import { isBlank } from './Utils';
import { PlayState } from './Constants';



let audioNode = null, lastPlayTime = null, singleton = null

export class RadioPlayer {
    constructor(channel) {
        this.channel = channel
        this.hls = new Hls()
        this.playState = PlayState.NONE
        this.channelChanged = false
        this.isBindHlsEvent = false
        this.webAudioApi = null
        this.pendingSoundEffect = null
        this.pendingStereoPan = null
        this.pendingVolumeGain = null
        this.animationFrameCnt = 0 //动画帧数计数器，控制事件触发频率，降低CPU占用
        this.stateRefreshFrequency = 60 //歌曲进度更新频度
        this.spectrumRefreshFrequency = 3 //歌曲频谱更新频度
    }

    static create() {
        if(singleton) return singleton
        singleton = new RadioPlayer()
        return singleton.initWebAudio()
            //.on('radio-init', node => singleton._createWebAudioApi(node))
            .on('radio-channelChange', channel => singleton.setChannel(channel))
            .on('radio-play', channel => singleton.playChannel(channel))
            .on('radio-togglePlay', () => singleton.togglePlay())
            .on('volume-set', volume => singleton.volume(volume))
            .on('radio-stop', () => singleton.setChannel(null))
            .on('playbackQueue-empty', () => singleton.setChannel(null))
            .on('track-changed', () => singleton.setChannel(null))
            .on('track-play', () => singleton.setChannel(null))
            .on('track-restore', channel => singleton.setChannel(channel))
            .on('track-setupSoundEffect', options => singleton.setupSoundEffect(options))
            .on('track-updateStereoPan', value => singleton.updateStereoPan(value))
            .on('track-updateVolumeGain', value => singleton.updateVolumeGain(value))
            .on('track-stateRefreshFrequency', value => singleton.stateRefreshFrequency = value)
            .on('track-spectrumRefreshFrequency', value => singleton.spectrumRefreshFrequency = value)
    }

    //播放
    play() {
        //非可处理异常，直接返回
        if (!Hls.isSupported() || !audioNode) return
        //数据异常，设置错误状态，让程序处理
        if (!this.channel || isBlank(this.channel.url)) {
            return this.setState(PlayState.PLAY_ERROR)
        }

        this.hls.loadSource(this.channel.url)
        this.hls.attachMedia(audioNode)

        //Hls事件绑定
        if (!this.isBindHlsEvent) {
            const self = this
            this.hls.on(Hls.Events.MANIFEST_PARSED, function () {
                audioNode.play()
                self.setState(PlayState.PLAYING)
                self.channelChanged = false
                lastPlayTime = Date.now()
                this.animationFrameCnt = 0
                requestAnimationFrame(self._step.bind(self))
            })
            this.hls.on(Hls.Events.ERROR, function () {
                self.setState(PlayState.PLAY_ERROR)
            })
            this.isBindHlsEvent = true
        }
    }

    playing() {
        return this.playState == PlayState.PLAYING
    }

    //暂停
    pause() {
        if (!Hls.isSupported() || !audioNode) return
        if (!this.playing()) return

        this.hls.detachMedia()
        this.setState(PlayState.PAUSE)
    }

    togglePlay() {
        if (this.playing()) {
            this.pause()
        } else {
            this.play()
        }
    }

    setState(state) {
        this.playState = state
        const { channel: track } = this
        this.notify('radio-state', { state, track, currentTime: 0, radio: true })
    }

    setChannel(channel) {
        this.pause()
        this.hls.stopLoad()
        this.channel = channel
        this.channelChanged = true
    }

    playChannel(channel) {
        this.setChannel(channel)
        this.play()
    }

    volume(value) {
        if (!Hls.isSupported() || !audioNode) return
        audioNode.volume = value
    }

    _step() {
        if (!this.playing()) return

        const nowTime = Date.now()
        const currentTime = (nowTime - lastPlayTime) || 0
        const currentSeconds = currentTime / 1000
        if (this.isStateRefreshEnabled()) this.notify('track-pos', { currentTime: currentSeconds, duration: 0 })
        this._resolveSound()
        this._countAnimationFrame()
        requestAnimationFrame(this._step.bind(this))
    }

    on(event, handler) {
        EventBus.on(event, handler)
        return this
    }

    notify(event, args) {
        EventBus.emit(event, args)
        return this
    }

    initWebAudio() {
        if (!audioNode) {
            //以这种方式创建的Element元素
            //好处，在浏览器开发者工具源码里看不到，而坏处也是源码里看不到......
            audioNode = document.createElement('audio')
            audioNode.setAttribute('crossOrigin', 'anonymous')
            audioNode.classList.add('audio-node')
            audioNode.classList.add('hidden')
            //默认优先查找id=app的元素作为父节点
            const parentNode = document.body.querySelector('#app') || document.body
            parentNode.appendChild(audioNode)
        }
        this._createWebAudioApi(audioNode)
        return this
    }

    _createWebAudioApi(node) {
        if (!node) return
        audioNode = node
        if (this.webAudioApi) return
        this.webAudioApi = WebAudioApi.create(new AudioContext(), audioNode)
    }

    _resolveSound() {
        if (!this.webAudioApi) return
        this._resolvePendingSoundEffect()
        if (!this.isSpectrumRefreshEnabled()) return
        
        const { leftChannelAnalyser, rightChannelAnalyser, analyser, audioCtx } = this.webAudioApi
        if (!analyser || !leftChannelAnalyser || !rightChannelAnalyser) return
        
        const { frequencyBinCount: leftFreqBinCount } = leftChannelAnalyser
        const { frequencyBinCount: rightFreqBinCount } = rightChannelAnalyser
        const { frequencyBinCount: freqBinCount } = analyser
        
        const leftFreqData = new Uint8Array(leftFreqBinCount)
        const rightFreqData = new Uint8Array(rightFreqBinCount)
        const freqData = new Uint8Array(freqBinCount)
        leftChannelAnalyser.getByteFrequencyData(leftFreqData)
        rightChannelAnalyser.getByteFrequencyData(rightFreqData)
        analyser.getByteFrequencyData(freqData)

        const { sampleRate } = audioCtx
        this.notify('track-spectrumData', { 
            leftFreqData, leftFreqBinCount, 
            rightFreqData, rightFreqBinCount, 
            freqData, freqBinCount, sampleRate, 
            analyser, leftChannelAnalyser, rightChannelAnalyser 
        })
    }

    updateEQ(values) {
        if (this.webAudioApi) {
            this.webAudioApi.updateEQ(values)
            this.pendingSoundEffect = null
        } else {
            this.pendingSoundEffect = this.pendingSoundEffect || {}
            Object.assign(this.pendingSoundEffect, { eqValues: values })
        }
    }

    updateIR(source) {
        if (this.webAudioApi) {
            this.webAudioApi.updateIR(source)
            this.pendingSoundEffect = null
        } else {
            this.pendingSoundEffect = this.pendingSoundEffect || {}
            Object.assign(this.pendingSoundEffect, { irSource: source })
        }
    }

    updateStereoPan(value) {
        if (this.webAudioApi) {
            this.webAudioApi.updateStereoPan(value)
            this.pendingStereoPan = null
        } else {
            this.pendingStereoPan = value
        }
    }

    updateVolumeGain(value) {
        if (this.webAudioApi) {
            this.webAudioApi.updateVolumeGain(value)
            this.pendingVolumeGain = null
        } else {
            this.pendingVolumeGain = value
        }
    }

    setupSoundEffect(options) {
        const { eqValues, irSource, stereoPan, volumeGain } = options
        this.updateEQ(eqValues)
        this.updateIR(irSource)
        this.updateStereoPan(stereoPan)
        this.updateVolumeGain(volumeGain)
    }

    _resolvePendingSoundEffect() {
        if (this.pendingSoundEffect) {
            const { eqValues, irSource } = this.pendingSoundEffect
            if(irSource) this.updateIR(irSource)
            if(eqValues) this.updateEQ(eqValues)
        }
        if(typeof this.pendingStereoPan == 'number') {
            this.updateStereoPan(this.pendingStereoPan)
        }
    }

    _countAnimationFrame() {
        const max = this.stateRefreshFrequency || 1024
        this.animationFrameCnt = (this.animationFrameCnt + 1) % max
    }

    isStateRefreshEnabled() {
        return this.animationFrameCnt % this.stateRefreshFrequency == 0
    }

    isSpectrumRefreshEnabled() {
        return this.animationFrameCnt % this.spectrumRefreshFrequency == 0
    }

}
