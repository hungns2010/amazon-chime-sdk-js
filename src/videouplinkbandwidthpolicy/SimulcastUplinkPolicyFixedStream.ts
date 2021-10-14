// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Logger from '../logger/Logger';
import AsyncScheduler from '../scheduler/AsyncScheduler';
import SimulcastLayers from '../simulcastlayers/SimulcastLayers';
import SimulcastTransceiverController from '../transceivercontroller/SimulcastTransceiverController';
import { Maybe } from '../utils/Types';
import DefaultVideoAndEncodeParameter from '../videocaptureandencodeparameter/DefaultVideoCaptureAndEncodeParameter';
import VideoStreamDescription from '../videostreamindex/VideoStreamDescription';
import VideoStreamIndex from '../videostreamindex/VideoStreamIndex';
import ConnectionMetrics from './ConnectionMetrics';
import SimulcastUplinkObserver from './SimulcastUplinkObserver';
import SimulcastUplinkPolicy from './SimulcastUplinkPolicy';

type EncodingParams = {
  maxBitrateKbps: number;
  scaleResolutionDownBy: number;
};

/**
 * [[SimulcastUplinkPolicyNScaleLowStream]] determines capture and encode
 *  parameters that reacts to estimated uplink bandwidth
 */
export default class SimulcastUplinkPolicyFixedStream implements SimulcastUplinkPolicy {
  static readonly startupDurationMs: number = 6000;
  static readonly holdDownDurationMs: number = 4000;
  static readonly defaultMaxFrameRate = 15;
  // Current rough estimates where webrtc disables streams
  static readonly kHiDisabledRate = 700;
  static readonly kMidDisabledRate = 240;

  private numSenders: number = 0;
  private numParticipants: number = -1;
  private optimalParameters: DefaultVideoAndEncodeParameter;
  private parametersInEffect: DefaultVideoAndEncodeParameter;
  private newQualityMap = new Map<string, RTCRtpEncodingParameters>();
  private currentQualityMap = new Map<string, RTCRtpEncodingParameters>();
  private newActiveStreams: SimulcastLayers = SimulcastLayers.LowAndHigh;
  private currentActiveStreams: SimulcastLayers = SimulcastLayers.LowAndHigh;
  private videoIndex: VideoStreamIndex | null = null;
  private currLocalDescriptions: VideoStreamDescription[] = [];
  private nextLocalDescriptions: VideoStreamDescription[] = [];
  private observerQueue: Set<SimulcastUplinkObserver> = new Set<SimulcastUplinkObserver>();

  constructor(private selfAttendeeId: string, private logger: Logger) {
    this.optimalParameters = new DefaultVideoAndEncodeParameter(0, 0, 0, 0, true);
    this.parametersInEffect = new DefaultVideoAndEncodeParameter(0, 0, 0, 0, true);
    this.currentQualityMap = this.fillEncodingParamWithBitrates([
      {
        maxBitrateKbps: 300,
        scaleResolutionDownBy: 4,
      },
      {
        maxBitrateKbps: 0,
        scaleResolutionDownBy: 2,
      },
      {
        maxBitrateKbps: 1200,
        scaleResolutionDownBy: 1,
      },
    ]);
    this.newQualityMap = this.currentQualityMap;
  }

  updateConnectionMetric({ uplinkKbps = 0 }: ConnectionMetrics): void {
    if (isNaN(uplinkKbps)) {
      return;
    }
  }

  private calculateEncodingParameters(): Map<string, RTCRtpEncodingParameters> {
    const newEncodingParameters: EncodingParams[] = [
      {
        maxBitrateKbps: 0,
        scaleResolutionDownBy: 4,
      },
      {
        maxBitrateKbps: 0,
        scaleResolutionDownBy: 1,
      },
      {
        maxBitrateKbps: 0,
        scaleResolutionDownBy: 1,
      },
    ];

    if (this.numParticipants >= 0 && this.numParticipants <= 2) {
      // Simulcast disabled for 2 attendee calls
      this.newActiveStreams = SimulcastLayers.High;
      newEncodingParameters[2].maxBitrateKbps = 1200;
    } else {
      this.newActiveStreams = SimulcastLayers.LowAndHigh;
      newEncodingParameters[0].maxBitrateKbps = 150;
      newEncodingParameters[2].maxBitrateKbps = 1200;
    }

    this.newQualityMap = this.fillEncodingParamWithBitrates(newEncodingParameters);
    if (!this.encodingParametersEqual()) {
      this.logger.info(
        `simulcast: policy:calculateEncodingParameters numSources:${this.numSenders} numClients:${
          this.numParticipants
        } newQualityMap: ${this.getQualityMapString(this.newQualityMap)}`
      );
    }
    return this.newQualityMap;
  }

  chooseMediaTrackConstraints(): MediaTrackConstraints {
    // Changing MediaTrackConstraints causes a restart of video input and possible small
    // scaling changes.  Always use 720p for now
    const trackConstraint: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 768 },
      frameRate: { ideal: 15 },
    };
    return trackConstraint;
  }

  chooseEncodingParameters(): Map<string, RTCRtpEncodingParameters> {
    this.currentQualityMap = this.newQualityMap;
    if (this.currentActiveStreams !== this.newActiveStreams) {
      this.currentActiveStreams = this.newActiveStreams;
      this.publishEncodingSimulcastLayer();
    }
    return this.currentQualityMap;
  }

  updateIndex(videoIndex: VideoStreamIndex): void {
    // the +1 for self is assuming that we intend to send video, since
    // the context here is VideoUplinkBandwidthPolicy
    const numSenders =
      videoIndex.numberOfVideoPublishingParticipantsExcludingSelf(this.selfAttendeeId) + 1;
    const numParticipants = videoIndex.numberOfParticipants();
    const numSendersChanged = numSenders !== this.numSenders;
    const numParticipantsChanged =
      (numParticipants > 2 && this.numParticipants <= 2) ||
      (numParticipants <= 2 && this.numParticipants > 2);
    this.numSenders = numSenders;
    this.numParticipants = numParticipants;
    this.optimalParameters = new DefaultVideoAndEncodeParameter(
      this.captureWidth(),
      this.captureHeight(),
      this.captureFrameRate(),
      this.maxBandwidthKbps(),
      false
    );
    this.videoIndex = videoIndex;
    if (numSendersChanged || numParticipantsChanged) {
      this.newQualityMap = this.calculateEncodingParameters();
    }
  }

  wantsResubscribe(): boolean {
    let constraintDiff = !this.encodingParametersEqual();

    this.nextLocalDescriptions = this.videoIndex.localStreamDescriptions();
    for (let i = 0; i < this.nextLocalDescriptions.length; i++) {
      const streamId = this.nextLocalDescriptions[i].streamId;
      if (streamId !== 0 && !!streamId) {
        const prevIndex = this.currLocalDescriptions.findIndex(val => {
          return val.streamId === streamId;
        });
        if (prevIndex !== -1) {
          if (
            this.nextLocalDescriptions[i].disabledByWebRTC !==
            this.currLocalDescriptions[prevIndex].disabledByWebRTC
          ) {
            constraintDiff = true;
          }
        }
      }
    }

    this.currLocalDescriptions = this.nextLocalDescriptions;
    return constraintDiff;
  }

  private compareEncodingParameter(
    encoding1: RTCRtpEncodingParameters,
    encoding2: RTCRtpEncodingParameters
  ): boolean {
    return JSON.stringify(encoding1) === JSON.stringify(encoding2);
  }

  private encodingParametersEqual(): boolean {
    let different = false;
    for (const ridName of SimulcastTransceiverController.NAME_ARR_ASCENDING) {
      different =
        different ||
        !this.compareEncodingParameter(
          this.newQualityMap.get(ridName),
          this.currentQualityMap.get(ridName)
        );
      if (different) {
        break;
      }
    }

    return !different;
  }

  chooseCaptureAndEncodeParameters(): DefaultVideoAndEncodeParameter {
    // should deprecate in this policy
    this.parametersInEffect = this.optimalParameters.clone();
    return this.parametersInEffect.clone();
  }

  private captureWidth(): number {
    // should deprecate in this policy
    const width = 1280;
    return width;
  }

  private captureHeight(): number {
    // should deprecate in this policy
    const height = 768;
    return height;
  }

  private captureFrameRate(): number {
    // should deprecate in this policy
    return 15;
  }

  maxBandwidthKbps(): number {
    // should deprecate in this policy
    return 1400;
  }

  setIdealMaxBandwidthKbps(_idealMaxBandwidthKbps: number): void {
    // should deprecate in this policy
  }

  setHasBandwidthPriority(_hasBandwidthPriority: boolean): void {
    // should deprecate in this policy
  }

  private fillEncodingParamWithBitrates(
    encodingParams: EncodingParams[]
  ): Map<string, RTCRtpEncodingParameters> {
    const newMap = new Map<string, RTCRtpEncodingParameters>();
    const toBps = 1000;
    const nameArr = SimulcastTransceiverController.NAME_ARR_ASCENDING;

    for (let i = 0; i < nameArr.length; i++) {
      const ridName = nameArr[i];
      newMap.set(ridName, {
        rid: ridName,
        active: encodingParams[i].maxBitrateKbps > 0 ? true : false,
        scaleResolutionDownBy: encodingParams[i].scaleResolutionDownBy,
        maxBitrate: encodingParams[i].maxBitrateKbps * toBps,
      });
    }

    return newMap;
  }

  private getQualityMapString(params: Map<string, RTCRtpEncodingParameters>): string {
    let qualityString = '';
    const localDescriptions = this.videoIndex.localStreamDescriptions();
    if (localDescriptions.length === 3) {
      params.forEach((value: RTCRtpEncodingParameters) => {
        let disabledByWebRTC = false;
        if (value.rid === 'low') disabledByWebRTC = localDescriptions[0].disabledByWebRTC;
        else if (value.rid === 'mid') disabledByWebRTC = localDescriptions[1].disabledByWebRTC;
        else disabledByWebRTC = localDescriptions[2].disabledByWebRTC;
        qualityString += `{ rid: ${value.rid} active:${value.active} disabledByWebRTC: ${disabledByWebRTC} maxBitrate:${value.maxBitrate}}`;
      });
    }
    return qualityString;
  }

  private publishEncodingSimulcastLayer(): void {
    this.forEachObserver(observer => {
      Maybe.of(observer.encodingSimulcastLayersDidChange).map(f =>
        f.bind(observer)(this.newActiveStreams)
      );
    });
  }

  addObserver(observer: SimulcastUplinkObserver): void {
    this.logger.info('adding simulcast uplink observer');
    this.observerQueue.add(observer);
  }

  removeObserver(observer: SimulcastUplinkObserver): void {
    this.logger.info('removing simulcast uplink observer');
    this.observerQueue.delete(observer);
  }

  forEachObserver(observerFunc: (observer: SimulcastUplinkObserver) => void): void {
    for (const observer of this.observerQueue) {
      AsyncScheduler.nextTick(() => {
        if (this.observerQueue.has(observer)) {
          observerFunc(observer);
        }
      });
    }
  }
}