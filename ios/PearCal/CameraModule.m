#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearCalCamera, NSObject)
RCT_EXTERN_METHOD(capture:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
@end
