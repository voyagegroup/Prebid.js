import { isFn, deepAccess, logMessage } from '../src/utils.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER, NATIVE, VIDEO } from '../src/mediaTypes.js';
import {config} from '../src/config.js';
import { convertOrtbRequestToProprietaryNative } from '../src/native.js';

const BIDDER_CODE = 'contentexchange';
const AD_URL = 'https://eu2.adnetwork.agency/pbjs';
const SYNC_URL = 'https://sync2.adnetwork.agency';

function isBidResponseValid (bid) {
  if (!bid.requestId || !bid.cpm || !bid.creativeId ||
    !bid.ttl || !bid.currency || !bid.meta) {
    return false;
  }

  switch (bid.mediaType) {
    case BANNER:
      return Boolean(bid.width && bid.height && bid.ad);
    case VIDEO:
      return Boolean(bid.vastUrl || bid.vastXml);
    case NATIVE:
      return Boolean(bid.native && bid.native.impressionTrackers && bid.native.impressionTrackers.length);
    default:
      return false;
  }
}

function getPlacementReqData (bid) {
  const { params, bidId, mediaTypes } = bid;
  const schain = bid.schain || {};
  const { placementId, adFormat } = params;
  const bidfloor = getBidFloor(bid);

  const placement = {
    placementId,
    bidId,
    adFormat,
    schain,
    bidfloor
  };

  switch (adFormat) {
    case BANNER:
      placement.sizes = mediaTypes[BANNER].sizes;
      break;
    case VIDEO:
      placement.playerSize = mediaTypes[VIDEO].playerSize;
      placement.minduration = mediaTypes[VIDEO].minduration;
      placement.maxduration = mediaTypes[VIDEO].maxduration;
      placement.mimes = mediaTypes[VIDEO].mimes;
      placement.protocols = mediaTypes[VIDEO].protocols;
      placement.startdelay = mediaTypes[VIDEO].startdelay;
      placement.placement = mediaTypes[VIDEO].placement;
      placement.skip = mediaTypes[VIDEO].skip;
      placement.skipafter = mediaTypes[VIDEO].skipafter;
      placement.minbitrate = mediaTypes[VIDEO].minbitrate;
      placement.maxbitrate = mediaTypes[VIDEO].maxbitrate;
      placement.delivery = mediaTypes[VIDEO].delivery;
      placement.playbackmethod = mediaTypes[VIDEO].playbackmethod;
      placement.api = mediaTypes[VIDEO].api;
      placement.linearity = mediaTypes[VIDEO].linearity;
      break;
    case NATIVE:
      placement.native = mediaTypes[NATIVE];
      break;
  }

  return placement;
}

function getBidFloor(bid) {
  if (!isFn(bid.getFloor)) {
    return deepAccess(bid, 'params.bidfloor', 0);
  }

  try {
    const bidFloor = bid.getFloor({
      currency: 'USD',
      mediaType: '*',
      size: '*',
    });
    return bidFloor.floor;
  } catch (_) {
    return 0
  }
}

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER, VIDEO, NATIVE],

  isBidRequestValid: (bid = {}) => {
    const { params, bidId, mediaTypes } = bid;
    let valid = Boolean(bidId &&
      params &&
      params.placementId &&
      params.adFormat
    );
    switch (params.adFormat) {
      case BANNER:
        valid = valid && Boolean(mediaTypes[BANNER] && mediaTypes[BANNER].sizes);
        break;
      case VIDEO:
        valid = valid && Boolean(mediaTypes[VIDEO] && mediaTypes[VIDEO].playerSize);
        break;
      case NATIVE:
        valid = valid && Boolean(mediaTypes[NATIVE]);
        break;
      default:
        valid = false;
    }
    return valid;
  },

  buildRequests: (validBidRequests = [], bidderRequest = {}) => {
    // convert Native ORTB definition to old-style prebid native definition
    validBidRequests = convertOrtbRequestToProprietaryNative(validBidRequests);

    let deviceWidth = 0;
    let deviceHeight = 0;

    let winLocation;
    try {
      const winTop = window.top;
      deviceWidth = winTop.screen.width;
      deviceHeight = winTop.screen.height;
      winLocation = winTop.location;
    } catch (e) {
      logMessage(e);
      winLocation = window.location;
    }

    const refferUrl = bidderRequest.refererInfo && bidderRequest.refererInfo.page;
    let refferLocation;
    try {
      refferLocation = refferUrl && new URL(refferUrl);
    } catch (e) {
      logMessage(e);
    }

    // TODO: does the fallback to 'window.location' make sense?
    let location = refferLocation || winLocation;
    const language = (navigator && navigator.language) ? navigator.language.split('-')[0] : '';
    const host = location.host;
    const page = location.pathname;
    const secure = location.protocol === 'https:' ? 1 : 0;
    const placements = [];
    const request = {
      deviceWidth,
      deviceHeight,
      language,
      secure,
      host,
      page,
      placements,
      coppa: config.getConfig('coppa') === true ? 1 : 0,
      ccpa: bidderRequest.uspConsent || undefined,
      gdpr: bidderRequest.gdprConsent || undefined,
      tmax: bidderRequest.timeout
    };

    const len = validBidRequests.length;
    for (let i = 0; i < len; i++) {
      const bid = validBidRequests[i];
      placements.push(getPlacementReqData(bid));
    }

    return {
      method: 'POST',
      url: AD_URL,
      data: request
    };
  },

  interpretResponse: (serverResponse) => {
    let response = [];
    for (let i = 0; i < serverResponse.body.length; i++) {
      let resItem = serverResponse.body[i];
      if (isBidResponseValid(resItem)) {
        const advertiserDomains = resItem.adomain && resItem.adomain.length ? resItem.adomain : [];
        resItem.meta = { ...resItem.meta, advertiserDomains };

        response.push(resItem);
      }
    }
    return response;
  },

  getUserSyncs: (syncOptions, serverResponses, gdprConsent, uspConsent) => {
    let syncType = syncOptions.iframeEnabled ? 'iframe' : 'image';
    let syncUrl = SYNC_URL + `/${syncType}?pbjs=1`;
    if (gdprConsent && gdprConsent.consentString) {
      if (typeof gdprConsent.gdprApplies === 'boolean') {
        syncUrl += `&gdpr=${Number(gdprConsent.gdprApplies)}&gdpr_consent=${gdprConsent.consentString}`;
      } else {
        syncUrl += `&gdpr=0&gdpr_consent=${gdprConsent.consentString}`;
      }
    }
    if (uspConsent && uspConsent.consentString) {
      syncUrl += `&ccpa_consent=${uspConsent.consentString}`;
    }

    const coppa = config.getConfig('coppa') ? 1 : 0;
    syncUrl += `&coppa=${coppa}`;

    return [{
      type: syncType,
      url: syncUrl
    }];
  }
};

registerBidder(spec);
