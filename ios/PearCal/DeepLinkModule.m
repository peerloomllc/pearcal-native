#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearCalDeepLink, NSObject)
RCT_EXTERN_METHOD(openURL:(NSString *)urlString)
RCT_EXTERN_METHOD(canOpenLightning:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(openLightning:(NSString *)invoice)
@end
