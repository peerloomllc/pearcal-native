#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearCalLink, NSObject)
RCT_EXTERN_METHOD(getPendingLink:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getPendingTab:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
@end
