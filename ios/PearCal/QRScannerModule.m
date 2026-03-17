#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearCalQRScanner, NSObject)
RCT_EXTERN_METHOD(scan:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
@end
